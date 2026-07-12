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
 */

import type { Env } from '../env';
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
    _env: Env,
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
      return Response.json({ ok: true, count: incoming.length, head: stored.nextSeq });
    });
  }
}

export function conversationStub(env: Env, threadId: string): DurableObjectStub {
  const id = env.CONVERSATION_DO.idFromName(threadId);
  return env.CONVERSATION_DO.get(id);
}
