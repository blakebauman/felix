/**
 * DO-backed `Session` / `SessionStore`. The `ConversationDO` is keyed by
 * thread id and serializes appends with `state.blockConcurrencyWhile` so
 * a fan-out parallel pattern can't lose events to a write race.
 *
 * Bounded retry with exponential backoff covers transient failure modes
 * (eviction during request, network blip). 3 attempts at 50ms / 150ms /
 * 450ms — small enough that the happy path isn't hurt, big enough to
 * survive a momentary stall.
 *
 * `persistFireAndForget` routes through `execCtx.waitUntil` so DO writes
 * don't block the LLM step. Terminal failures emit a `checkpoint_failure`
 * audit event + `orchestrator_checkpoint_failures` counter so the
 * silent-divergence failure mode (model history doesn't match disk)
 * surfaces in observability instead of being swallowed by `console.warn`.
 */

import { recordEvent } from '../audit/store';
import { getContext } from '../context';
import type { Env } from '../env';
import { conversationStub } from '../memory/conversation-do';
import { recordCounter } from '../observability/metrics';
import {
  type AppendableEvent,
  analyzeWake,
  type GetEventsOpts,
  type Session,
  type SessionEvent,
  type SessionStore,
  type WakeState,
} from './types';

/** Non-retriable error — a 4xx (client) response the DO won't accept on retry. */
class ClientError extends Error {}

async function retryFetch(
  fn: () => Promise<Response>,
  attempts = 3,
  baseMs = 50,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const resp = await fn();
      if (resp.ok) return resp;
      const body = await resp.text().catch(() => '');
      const message = `status ${resp.status}: ${body.slice(0, 200)}`;
      // A 4xx is a client error the DO will reject identically on retry —
      // fail fast instead of burning the retry budget. Throwing a
      // `ClientError` (rather than swallowing into `lastErr`) means the
      // catch below rethrows it immediately, so no backoff/continue runs.
      if (resp.status < 500) throw new ClientError(message);
      lastErr = new Error(message);
    } catch (err) {
      if (err instanceof ClientError) throw err;
      lastErr = err;
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, baseMs * 3 ** i));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function buildEventsQuery(opts?: GetEventsOpts): string {
  if (!opts) return '';
  const params = new URLSearchParams();
  if (opts.from !== undefined) params.set('from', String(opts.from));
  if (opts.to !== undefined) params.set('to', String(opts.to));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.kinds?.length) params.set('kinds', opts.kinds.join(','));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

class DoSession implements Session {
  constructor(
    private readonly env: Env,
    readonly id: string,
  ) {}

  async getEvents(opts?: GetEventsOpts): Promise<SessionEvent[]> {
    if (!this.id) return [];
    const resp = await conversationStub(this.env, this.id).fetch(
      `https://do/events${buildEventsQuery(opts)}`,
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as { events?: SessionEvent[] };
    return data.events ?? [];
  }

  async head(): Promise<{ seq: number }> {
    if (!this.id) return { seq: 0 };
    const resp = await conversationStub(this.env, this.id).fetch('https://do/head');
    if (!resp.ok) return { seq: 0 };
    return (await resp.json()) as { seq: number };
  }

  async append(event: AppendableEvent): Promise<void> {
    if (!this.id) return;
    await this.appendBatch([event]);
  }

  async appendBatch(events: ReadonlyArray<AppendableEvent>): Promise<void> {
    if (!this.id || events.length === 0) return;
    await retryFetch(() =>
      conversationStub(this.env, this.id).fetch('https://do/events', {
        method: 'POST',
        body: JSON.stringify({ events }),
      }),
    );
  }

  async reset(): Promise<void> {
    if (!this.id) return;
    await conversationStub(this.env, this.id).fetch('https://do/events', { method: 'DELETE' });
  }

  async wake(): Promise<WakeState> {
    if (!this.id) {
      return { fresh: true, headSeq: 0, pendingToolCalls: [], endedOnAssistant: false };
    }
    return analyzeWake(await this.getEvents());
  }
}

class NoopSession implements Session {
  readonly id = '';
  async getEvents(): Promise<SessionEvent[]> {
    return [];
  }
  async head(): Promise<{ seq: number }> {
    return { seq: 0 };
  }
  async append(): Promise<void> {}
  async appendBatch(): Promise<void> {}
  async reset(): Promise<void> {}
  async wake(): Promise<WakeState> {
    return { fresh: true, headSeq: 0, pendingToolCalls: [], endedOnAssistant: false };
  }
}

class DoSessionStore implements SessionStore {
  constructor(private readonly env: Env) {}
  open(threadId: string): Session {
    if (!threadId) return new NoopSession();
    return new DoSession(this.env, threadId);
  }
}

class NoopSessionStore implements SessionStore {
  open(): Session {
    return new NoopSession();
  }
}

export const noopSessionStore: SessionStore = new NoopSessionStore();

/**
 * Resolve a `SessionStore` from the manifest `memory.checkpointer` enum.
 * `do` (and legacy aliases `agentcore` / `sqlite`) → DO-backed store.
 * `none` → no-op store.
 */
export function getSessionStore(env: Env, mode: string): SessionStore {
  if (mode === 'do' || mode === 'agentcore' || mode === 'sqlite') {
    return new DoSessionStore(env);
  }
  return noopSessionStore;
}

/**
 * Persist a batch of events for `session` without blocking the calling loop.
 *
 * Routes through `execCtx.waitUntil` when available so the worker holds
 * the request open until the DO write completes. Bounded retries live
 * inside `DoSession.appendBatch`; if every attempt fails this records a
 * `checkpoint_failure` audit event + counter so the silent-divergence
 * failure mode (model history doesn't match disk) is observable instead
 * of being swallowed by `console.warn`.
 */
export function persistFireAndForget(
  session: Session,
  events: ReadonlyArray<AppendableEvent>,
  opts: { manifestId: string },
): void {
  if (!session.id || events.length === 0) return;
  const ctx = getContext();
  const p = session.appendBatch(events).catch((err) => {
    const message = String((err as Error)?.message ?? err);
    console.warn('session.appendBatch failed after retries', message);
    recordCounter('orchestrator_checkpoint_failures', { manifest_id: opts.manifestId });
    if (ctx) {
      recordEvent({
        tenantId: ctx.auth.principal.tenantId,
        eventType: 'checkpoint_failure',
        principalSubject: ctx.auth.principal.subject,
        manifestId: opts.manifestId,
        status: 'failed',
        payload: {
          thread_id: session.id,
          event_count: events.length,
          error: message,
        },
      });
    }
  });
  if (ctx?.execCtx) ctx.execCtx.waitUntil(p);
  else void p;
}
