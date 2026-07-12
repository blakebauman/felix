/**
 * ConversationDO — per-thread session log.
 *
 * Stores `SessionEvent`s (a superset of the legacy `StoredMessage`: every
 * record carries a monotonic `seq` and a `kind` discriminator alongside
 * the message fields). The harness reads slices through
 * `GET /events?from=N&to=N&limit=N&kinds=...` and appends batches through
 * `POST /events` — there is no all-or-nothing `/history` dump.
 *
 * Endpoints:
 *   GET    /events?from=&to=&limit=&kinds=   — slice with cursor + kind filter
 *   GET    /head                              — { seq: next-seq-to-be-assigned }
 *   POST   /events  { events: AppendableEvent[] } — append batch
 *   DELETE /events                            — wipe state
 *
 * Concurrent appends are serialized via `state.blockConcurrencyWhile` so
 * a fanned-out parallel agent doesn't lose events to a write race.
 *
 * On read, storage written by earlier versions (under the `state.messages`
 * key) is migrated to events in memory; the migrated shape is persisted
 * on the next append.
 *
 * Idle TTL: every append sets/renews a Durable Object alarm for
 * `now + CONVERSATION_IDLE_TTL_DAYS`. When the alarm fires and the thread
 * has been idle ≥ TTL its whole storage is wiped (day-2 GC — otherwise a
 * thread lives forever, only rolling off at `MAX_STORED_EVENTS`); if it was
 * touched more recently the alarm reschedules to the exact expiry point.
 */

import type { Env } from '../env';
import { recordCounterDetached } from '../observability/metrics';
import type { AppendableEvent, SessionEvent, SessionEventKind } from '../session/types';

interface LegacyStoredMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  ts: number;
}

interface ConversationState {
  threadId: string;
  events: SessionEvent[];
  nextSeq: number;
  createdAt: number;
  updatedAt: number;
  /** Legacy field — present on storage written before the events refactor. */
  messages?: LegacyStoredMessage[];
}

function legacyToEvent(m: LegacyStoredMessage, seq: number): SessionEvent {
  const kind: SessionEventKind = m.role === 'tool' ? 'tool_result' : 'message';
  return {
    seq,
    ts: m.ts,
    kind,
    role: m.role,
    content: m.content,
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
  };
}

function migrate(stored: ConversationState | null, now: number): ConversationState {
  if (!stored) {
    return { threadId: '', events: [], nextSeq: 0, createdAt: now, updatedAt: now };
  }
  if (Array.isArray(stored.events) && typeof stored.nextSeq === 'number') {
    // Already migrated; drop a stray `messages` field defensively.
    if (stored.messages) {
      const { messages: _drop, ...rest } = stored;
      return { ...rest, events: rest.events ?? [], nextSeq: rest.nextSeq ?? 0 };
    }
    return stored;
  }
  // Migrate legacy `messages` → `events` with synthesized seq.
  const legacy = stored.messages ?? [];
  const events = legacy.map((m, i) => legacyToEvent(m, i));
  return {
    threadId: stored.threadId ?? '',
    events,
    nextSeq: events.length,
    createdAt: stored.createdAt ?? now,
    updatedAt: stored.updatedAt ?? now,
  };
}

function parseKinds(raw: string | null): SessionEventKind[] | null {
  if (!raw) return null;
  const allowed = new Set<SessionEventKind>([
    'message',
    'tool_call',
    'tool_result',
    'thinking',
    'audit',
  ]);
  const kinds = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is SessionEventKind => allowed.has(s as SessionEventKind));
  return kinds.length ? kinds : null;
}

// Hard ceiling on how many events a single read can pull back. Without it a
// caller can request the entire log (or pass `Infinity`/`NaN` through bare
// `Number(...)`), turning one read into an unbounded memory/serialization cost.
export const MAX_EVENTS = 1000;

// Hard ceiling on how many events a single thread STORES. Every append does a
// full get→push→put of the whole array, so an unbounded log grows O(n) per
// append in both CPU and DO-storage-value size (the single-value put has a
// platform size limit). A long-lived thread would otherwise let one tenant
// drive unbounded storage/CPU growth. When exceeded we roll off the oldest
// events, preserving pinned anchors (`metadata.pinned`) since strategies always
// re-include those. `seq`/`nextSeq` stay monotonic so read cursors are
// unaffected — pruned seqs simply return no rows.
export const MAX_STORED_EVENTS = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Idle-TTL default + clamp bounds for `CONVERSATION_IDLE_TTL_DAYS` (days). */
export const DEFAULT_CONVERSATION_IDLE_TTL_DAYS = 90;
const MIN_IDLE_TTL_DAYS = 1;
const MAX_IDLE_TTL_DAYS = 3650; // ~10 years — an effective "keep forever" ceiling.

/**
 * Resolve the conversation idle-TTL (days) from the optional
 * `CONVERSATION_IDLE_TTL_DAYS` env var. Parsed defensively (mirrors
 * `parseAuditRetentionDays`): unset / non-numeric falls back to the default,
 * and valid values are floored and clamped to `[MIN_IDLE_TTL_DAYS,
 * MAX_IDLE_TTL_DAYS]` so a fat-fingered override can neither expire a thread
 * on write (0 days) nor overflow.
 */
export function parseConversationIdleTtlDays(env: Env): number {
  const raw = env.CONVERSATION_IDLE_TTL_DAYS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CONVERSATION_IDLE_TTL_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CONVERSATION_IDLE_TTL_DAYS;
  return Math.max(MIN_IDLE_TTL_DAYS, Math.min(MAX_IDLE_TTL_DAYS, Math.floor(n)));
}

function isPinnedEvent(e: SessionEvent): boolean {
  return (e.metadata as { pinned?: unknown } | undefined)?.pinned === true;
}

/**
 * Trim a stored event array to at most `MAX_STORED_EVENTS`, dropping the oldest
 * non-pinned events first. Pinned anchors are always retained; if pinned events
 * alone exceed the cap they are all kept (correctness over the ceiling).
 */
export function rollOffEvents(events: SessionEvent[]): SessionEvent[] {
  if (events.length <= MAX_STORED_EVENTS) return events;
  const pinned = events.filter(isPinnedEvent);
  const unpinned = events.filter((e) => !isPinnedEvent(e));
  const keepUnpinned = Math.max(0, MAX_STORED_EVENTS - pinned.length);
  const trimmedUnpinned = unpinned.slice(unpinned.length - keepUnpinned);
  // Re-merge into seq order so slices stay monotonic.
  return [...pinned, ...trimmedUnpinned].sort((a, b) => a.seq - b.seq);
}

/**
 * Parse a query-string cursor/limit into a clean bounded integer. Rejects
 * missing, non-numeric (`NaN`), non-finite (`Infinity`), and negative inputs
 * by returning `null`; clamps to `max` when provided.
 */
export function parseBound(raw: string | null, max?: number): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const floored = Math.floor(n);
  return max !== undefined ? Math.min(floored, max) : floored;
}

function sliceEvents(
  events: SessionEvent[],
  from: number | null,
  to: number | null,
  limit: number | null,
  kinds: SessionEventKind[] | null,
): SessionEvent[] {
  let out = events;
  if (from !== null) out = out.filter((e) => e.seq >= from);
  if (to !== null) out = out.filter((e) => e.seq < to);
  if (kinds) {
    const kindSet = new Set(kinds);
    out = out.filter((e) => kindSet.has(e.kind));
  }
  if (limit !== null && limit >= 0) out = out.slice(0, limit);
  return out;
}

export class ConversationDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/events' && req.method === 'GET') return this.getEvents(url);
    if (url.pathname === '/events' && req.method === 'POST') return this.appendEvents(req);
    if (url.pathname === '/events' && req.method === 'DELETE') return this.reset();
    if (url.pathname === '/head' && req.method === 'GET') return this.head();
    return new Response('not found', { status: 404 });
  }

  private async loadOrInit(now: number): Promise<ConversationState> {
    const stored = await this.state.storage.get<ConversationState>('state');
    return migrate(stored ?? null, now);
  }

  private async getEvents(url: URL): Promise<Response> {
    const stored = await this.loadOrInit(Date.now());
    const from = parseBound(url.searchParams.get('from'));
    const to = parseBound(url.searchParams.get('to'));
    // Absent `limit` stays unbounded so full_replay / wake still read the
    // whole log; an explicit limit is sanitized and clamped to MAX_EVENTS.
    const limit = parseBound(url.searchParams.get('limit'), MAX_EVENTS);
    const kinds = parseKinds(url.searchParams.get('kinds'));
    return Response.json({
      events: sliceEvents(stored.events, from, to, limit, kinds),
      head: stored.nextSeq,
    });
  }

  private async head(): Promise<Response> {
    const stored = await this.loadOrInit(Date.now());
    return Response.json({ seq: stored.nextSeq });
  }

  private async reset(): Promise<Response> {
    await this.state.storage.delete('state');
    return Response.json({ ok: true });
  }

  private async appendEvents(req: Request): Promise<Response> {
    const body = (await req.json()) as { events?: AppendableEvent[] };
    const incoming = body.events ?? [];
    if (incoming.length === 0) return Response.json({ ok: true, count: 0 });
    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const stored = await this.loadOrInit(now);
      for (const ev of incoming) {
        stored.events.push({
          ...ev,
          seq: stored.nextSeq,
          ts: ev.ts ?? now,
        });
        stored.nextSeq += 1;
      }
      stored.updatedAt = now;
      // Bound total stored events so a long-lived thread can't drive unbounded
      // DO storage/CPU growth. nextSeq is untouched, so cursors keep working.
      stored.events = rollOffEvents(stored.events);
      delete stored.messages; // shed legacy field once we've written events
      await this.state.storage.put('state', stored);
      // Set/renew the idle-TTL alarm so an untouched thread's storage is
      // eventually reclaimed instead of living forever behind MAX_STORED_EVENTS.
      const ttlMs = parseConversationIdleTtlDays(this.env) * DAY_MS;
      await this.state.storage.setAlarm(now + ttlMs);
      return Response.json({ ok: true, count: incoming.length, head: stored.nextSeq });
    });
  }

  /**
   * Idle-TTL alarm. Fires at the last scheduled expiry point; if the thread
   * has been idle for at least the (freshly re-read) TTL its whole storage is
   * wiped, otherwise the alarm reschedules to the exact expiry so a write that
   * landed after the alarm was set extends the lifetime correctly.
   */
  async alarm(): Promise<void> {
    const stored = await this.state.storage.get<ConversationState>('state');
    if (!stored) return; // already gone — nothing to expire.
    const now = Date.now();
    const ttlMs = parseConversationIdleTtlDays(this.env) * DAY_MS;
    const updatedAt = stored.updatedAt ?? stored.createdAt ?? 0;
    if (now - updatedAt >= ttlMs) {
      await this.state.storage.deleteAll();
      recordCounterDetached(this.env, 'orchestrator_conversation_idle_expired', {});
      return;
    }
    // Touched more recently than the alarm assumed — reschedule to real expiry.
    await this.state.storage.setAlarm(updatedAt + ttlMs);
  }
}

export function conversationStub(env: Env, threadId: string): DurableObjectStub {
  const id = env.CONVERSATION_DO.idFromName(threadId);
  return env.CONVERSATION_DO.get(id);
}
