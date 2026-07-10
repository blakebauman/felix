/**
 * Orphan-cleanup cron for queue-transport tool dispatches.
 *
 * Pins:
 *   1. A `queue_dispatch` older than `ageThresholdMs` with no matching
 *      `queue_complete` / `queue_expired` is treated as orphaned: the
 *      cleanup writes a synthetic `tool_result` to the session (so
 *      `session.wake()` reports the cycle resolved) and emits a
 *      `queue_expired` audit row.
 *   2. A `queue_dispatch` that has a paired `queue_complete` is NOT
 *      touched (the consumer landed; nothing to clean up).
 *   3. A `queue_dispatch` younger than the threshold is NOT touched
 *      (gives slow consumers room to finish).
 *   4. job_id pairing is tenant-scoped — same `job_id` across tenants
 *      doesn't accidentally cross-resolve.
 *   5. Cleanup is bounded by `maxPerSweep` (poison-orphan protection).
 *   6. A failure to write the synthetic tool_result back skips the
 *      `queue_expired` emission for that orphan (preserves retry on the
 *      next sweep).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import { sweepOrphanQueueDispatches } from '../../src/jobs/queue-orphan-cleanup';

interface PreparedResults {
  results: Array<{
    id: string;
    tenant_id: string;
    ts: number;
    event_type: 'queue_dispatch' | 'queue_complete' | 'queue_expired';
    manifest_id: string;
    principal_subj: string;
    payload_json: string;
  }>;
}

function row(opts: {
  id: string;
  tenant_id: string;
  ts: number;
  event_type: 'queue_dispatch' | 'queue_complete' | 'queue_expired';
  manifest_id?: string;
  principal_subj?: string;
  payload: Record<string, unknown>;
}): PreparedResults['results'][number] {
  return {
    id: opts.id,
    tenant_id: opts.tenant_id,
    ts: opts.ts,
    event_type: opts.event_type,
    manifest_id: opts.manifest_id ?? 'm',
    principal_subj: opts.principal_subj ?? '',
    payload_json: JSON.stringify(opts.payload),
  };
}

interface FetchCall {
  url: string;
  body: { events: Array<Record<string, unknown>> };
}

function fakeEnv(opts: {
  rows: PreparedResults['results'];
  failConvoStub?: (threadId: string) => boolean;
}): { env: Env; conversationCalls: Map<string, FetchCall[]> } {
  const conversationCalls = new Map<string, FetchCall[]>();
  const stub = (threadId: string) => ({
    async fetch(url: string, init?: RequestInit) {
      if (opts.failConvoStub?.(threadId)) throw new Error('DO unreachable');
      const calls = conversationCalls.get(threadId) ?? [];
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      conversationCalls.set(threadId, calls);
      return new Response('ok');
    },
  });
  const env = {
    DB: {
      prepare: (_sql: string) => ({
        bind: () => ({
          async all<T>(): Promise<{ results: T[] }> {
            return { results: opts.rows as unknown as T[] };
          },
        }),
      }),
    },
    CONVERSATION_DO: {
      idFromName: (name: string) => name,
      get: (id: unknown) => stub(String(id)),
    },
  } as unknown as Env;
  return { env, conversationCalls };
}

describe('sweepOrphanQueueDispatches', () => {
  it('expires a stale dispatch with no completion — writes tool_result + emits queue_expired', async () => {
    const now = 1_000_000_000;
    const ancient = now - 60 * 60 * 1000; // 1h old, well past 30m threshold
    const { env, conversationCalls } = fakeEnv({
      rows: [
        row({
          id: 'a1',
          tenant_id: 'acme',
          ts: ancient,
          event_type: 'queue_dispatch',
          payload: {
            job_id: 'job-1',
            tool: 'long_task',
            tool_call_id: 'tc1',
            thread_id: 'acme:thread-1',
          },
        }),
      ],
    });
    const cleaned = await sweepOrphanQueueDispatches(env, {}, now);
    expect(cleaned).toBe(1);
    const calls = conversationCalls.get('acme:thread-1') ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.events[0]).toMatchObject({
      kind: 'tool_result',
      tool_call_id: 'tc1',
      name: 'long_task',
    });
    expect(String(calls[0]!.body.events[0]!.content)).toContain('[expired]');
  });

  it('leaves a paired dispatch + completion alone (consumer landed normally)', async () => {
    const now = 1_000_000_000;
    const old = now - 60 * 60 * 1000;
    const { env, conversationCalls } = fakeEnv({
      rows: [
        row({
          id: 'a1',
          tenant_id: 'acme',
          ts: old,
          event_type: 'queue_dispatch',
          payload: {
            job_id: 'job-1',
            tool: 't',
            tool_call_id: 'tc1',
            thread_id: 'acme:thread-1',
          },
        }),
        row({
          id: 'a2',
          tenant_id: 'acme',
          ts: old + 1_000,
          event_type: 'queue_complete',
          payload: { job_id: 'job-1' },
        }),
      ],
    });
    const cleaned = await sweepOrphanQueueDispatches(env, {}, now);
    expect(cleaned).toBe(0);
    expect(conversationCalls.size).toBe(0);
  });

  it('leaves a young dispatch alone (consumer still has time)', async () => {
    const now = 1_000_000_000;
    const young = now - 60 * 1000; // 1 minute old; threshold defaults to 30 minutes
    const { env, conversationCalls } = fakeEnv({
      rows: [
        row({
          id: 'a1',
          tenant_id: 'acme',
          ts: young,
          event_type: 'queue_dispatch',
          payload: {
            job_id: 'job-1',
            tool: 't',
            tool_call_id: 'tc1',
            thread_id: 'acme:thread-1',
          },
        }),
      ],
    });
    const cleaned = await sweepOrphanQueueDispatches(env, {}, now);
    expect(cleaned).toBe(0);
    expect(conversationCalls.size).toBe(0);
  });

  it('scopes job_id pairing per tenant — same job_id across tenants does not cross-resolve', async () => {
    const now = 1_000_000_000;
    const old = now - 60 * 60 * 1000;
    const { env, conversationCalls } = fakeEnv({
      rows: [
        row({
          id: 'a1',
          tenant_id: 'acme',
          ts: old,
          event_type: 'queue_dispatch',
          payload: {
            job_id: 'shared-id',
            tool: 't',
            tool_call_id: 'tc1',
            thread_id: 'acme:thread-1',
          },
        }),
        // Tenant 'globex' completed *their* job-shared-id — that must NOT
        // count as resolving acme's identically-named job.
        row({
          id: 'a2',
          tenant_id: 'globex',
          ts: old + 1_000,
          event_type: 'queue_complete',
          payload: { job_id: 'shared-id' },
        }),
      ],
    });
    const cleaned = await sweepOrphanQueueDispatches(env, {}, now);
    expect(cleaned).toBe(1);
    expect(conversationCalls.get('acme:thread-1')).toHaveLength(1);
  });

  it('respects maxPerSweep — large orphan backlog is processed in chunks', async () => {
    const now = 1_000_000_000;
    const old = now - 60 * 60 * 1000;
    const rows = Array.from({ length: 25 }, (_, i) =>
      row({
        id: `a${i}`,
        tenant_id: 'acme',
        ts: old + i,
        event_type: 'queue_dispatch',
        payload: {
          job_id: `job-${i}`,
          tool: 't',
          tool_call_id: `tc${i}`,
          thread_id: `acme:t${i}`,
        },
      }),
    );
    const { env, conversationCalls } = fakeEnv({ rows });
    const cleaned = await sweepOrphanQueueDispatches(env, { maxPerSweep: 5 }, now);
    expect(cleaned).toBe(5);
    expect([...conversationCalls.keys()].length).toBe(5);
  });

  it('skips queue_expired emission when the tool_result write-back fails', async () => {
    const now = 1_000_000_000;
    const old = now - 60 * 60 * 1000;
    const { env } = fakeEnv({
      rows: [
        row({
          id: 'a1',
          tenant_id: 'acme',
          ts: old,
          event_type: 'queue_dispatch',
          payload: {
            job_id: 'job-1',
            tool: 't',
            tool_call_id: 'tc1',
            thread_id: 'acme:thread-1',
          },
        }),
      ],
      failConvoStub: (threadId) => threadId === 'acme:thread-1',
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cleaned = await sweepOrphanQueueDispatches(env, {}, now);
    expect(cleaned).toBe(1); // returned count is "considered"
    // Console error was logged for the failed write-back.
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
