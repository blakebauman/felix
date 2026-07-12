/**
 * Internal write-back endpoint for queue consumers. Pins:
 *
 *   1. Missing `CONSUMER_SHARED_SECRET` → 503 (refuse to authenticate
 *      anyone). Production must configure the secret.
 *   2. Missing or wrong `x-consumer-secret` → 401.
 *   3. Malformed thread_id (no `tenant:` prefix) → 400.
 *   4. Invalid body / non-tool_result events → 400.
 *   5. Missing audit store (DB) → 503 — dispatch pairing can't be verified,
 *      fail closed.
 *   6. Dispatch pairing (the H4 integrity fix):
 *      - No matching `queue_dispatch` for (tenant, tool_call_id) → 409, no
 *        write (forged / cross-tenant / not-yet-visible).
 *      - A matching outstanding dispatch → 200, forwards the tool_result.
 *      - A dispatch already resolved (`queue_complete`/`queue_expired`
 *        present) → 409 (replay), no write.
 *      - A forged write-back naming another tenant's thread → 409, no write.
 *   7. Happy path → forwards `tool_result` events to the ConversationDO
 *      and returns 200 with the written count.
 *   8. ConversationDO failure → 502, no audit emission.
 *   9. Successful write emits `queue_complete` audit per event, carrying the
 *      paired dispatch's manifest id and the `job_id` from metadata.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { buildInternalRouter } from '../../src/api/internal';
import type { AuthContext } from '../../src/auth/context';
import type { Env } from '../../src/env';

interface DispatchRow {
  tenant_id: string;
  tool_call_id: string;
  event_type: 'queue_dispatch' | 'queue_complete' | 'queue_expired';
  thread_id: string;
  job_id: string;
  manifest_id: string;
}

interface Captured {
  doFetches: Array<{ url: string; body: string }>;
}

function makeEnv(opts: {
  secret?: string;
  failDo?: boolean;
  noDb?: boolean;
  dispatches?: DispatchRow[];
}): { env: Env; cap: Captured } {
  const cap: Captured = { doFetches: [] };
  const stub = {
    async fetch(url: string, init?: RequestInit) {
      cap.doFetches.push({ url, body: String(init?.body) });
      if (opts.failDo) return new Response('DO error', { status: 500 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  };
  const dispatches = opts.dispatches ?? [];
  // Minimal D1 stub: understands the single tenant-scoped
  // `findQueueDispatchState` query (binds: [tenant_id, tool_call_id]).
  const db = {
    prepare(_sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          binds = args;
          return this;
        },
        async all() {
          const [tenantId, toolCallId] = binds as [string, string];
          const results = dispatches
            .filter((d) => d.tenant_id === tenantId && d.tool_call_id === toolCallId)
            .map((d) => ({
              event_type: d.event_type,
              manifest_id: d.manifest_id,
              thread_id: d.thread_id,
              job_id: d.job_id,
            }));
          return { results };
        },
      };
    },
  };
  return {
    cap,
    env: {
      ...(opts.secret !== undefined ? { CONSUMER_SHARED_SECRET: opts.secret } : {}),
      ...(opts.noDb ? {} : { DB: db }),
      CONVERSATION_DO: {
        idFromName: (name: string) => name,
        get: () => stub,
      },
    } as unknown as Env,
  };
}

async function fetchInternal(
  env: Env,
  threadId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
  app.route('/internal', buildInternalRouter());
  return app.fetch(
    new Request(`https://t/internal/sessions/${encodeURIComponent(threadId)}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

/** A `queue_dispatch` row for tenant `acme`, thread `acme:thread-1`, tc1. */
function acmeDispatch(overrides: Partial<DispatchRow> = {}): DispatchRow {
  return {
    tenant_id: 'acme',
    tool_call_id: 'tc1',
    event_type: 'queue_dispatch',
    thread_id: 'acme:thread-1',
    job_id: 'job-42',
    manifest_id: 'researcher',
    ...overrides,
  };
}

describe('internal write-back endpoint', () => {
  const goodBody = {
    events: [
      {
        kind: 'tool_result',
        tool_call_id: 'tc1',
        name: 'long_task',
        content: '[done] hello',
        metadata: { job_id: 'job-42', source: 'queue-consumer' },
      },
    ],
  };

  it('returns 503 when CONSUMER_SHARED_SECRET is not configured', async () => {
    const { env } = makeEnv({});
    const resp = await fetchInternal(env, 'acme:thread-1', goodBody);
    expect(resp.status).toBe(503);
  });

  it('returns 401 when x-consumer-secret is missing', async () => {
    const { env } = makeEnv({ secret: 'shhh' });
    const resp = await fetchInternal(env, 'acme:thread-1', goodBody);
    expect(resp.status).toBe(401);
  });

  it('returns 401 when x-consumer-secret is wrong', async () => {
    const { env } = makeEnv({ secret: 'shhh' });
    const resp = await fetchInternal(env, 'acme:thread-1', goodBody, {
      'x-consumer-secret': 'wrong',
    });
    expect(resp.status).toBe(401);
  });

  it('returns 503 when the audit store (DB) is unavailable', async () => {
    const { env, cap } = makeEnv({ secret: 'shhh', noDb: true, dispatches: [acmeDispatch()] });
    const resp = await fetchInternal(env, 'acme:thread-1', goodBody, {
      'x-consumer-secret': 'shhh',
    });
    expect(resp.status).toBe(503);
    expect(cap.doFetches).toHaveLength(0);
  });

  it('returns 400 for a malformed thread_id', async () => {
    const { env } = makeEnv({ secret: 'shhh' });
    const resp = await fetchInternal(env, 'no-tenant-prefix', goodBody, {
      'x-consumer-secret': 'shhh',
    });
    expect(resp.status).toBe(400);
  });

  it('returns 400 for events that are not tool_result', async () => {
    const { env } = makeEnv({ secret: 'shhh' });
    const resp = await fetchInternal(
      env,
      'acme:thread-1',
      {
        events: [{ kind: 'message', role: 'user', content: 'sneaky' }],
      },
      { 'x-consumer-secret': 'shhh' },
    );
    expect(resp.status).toBe(400);
  });

  it('rejects a write-back with no matching dispatch (409) and writes nothing', async () => {
    // No dispatches configured — a forged tool_call_id.
    const { env, cap } = makeEnv({ secret: 'shhh', dispatches: [] });
    const resp = await fetchInternal(env, 'acme:thread-1', goodBody, {
      'x-consumer-secret': 'shhh',
    });
    expect(resp.status).toBe(409);
    expect(cap.doFetches).toHaveLength(0);
  });

  it('accepts a write-back with a matching outstanding dispatch (200) and writes the tool_result', async () => {
    const { env, cap } = makeEnv({ secret: 'shhh', dispatches: [acmeDispatch()] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const resp = await fetchInternal(env, 'acme:thread-1', goodBody, {
      'x-consumer-secret': 'shhh',
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; written: number };
    expect(body).toEqual({ ok: true, written: 1 });
    expect(cap.doFetches).toHaveLength(1);
    const sent = JSON.parse(cap.doFetches[0]!.body) as {
      events: Array<{ kind: string; tool_call_id: string; role: string }>;
    };
    expect(sent.events[0]).toMatchObject({
      kind: 'tool_result',
      tool_call_id: 'tc1',
      name: 'long_task',
      role: 'tool',
    });
    // Audit emission: queue_complete carrying the dispatch's manifest id and
    // the job_id from metadata.
    const auditCalls = logSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes('"event_type":"queue_complete"'));
    expect(auditCalls.length).toBeGreaterThan(0);
    expect(auditCalls[0]!).toContain('"job_id":"job-42"');
    expect(auditCalls[0]!).toContain('"manifest_id":"researcher"');
    logSpy.mockRestore();
  });

  it('rejects a second write-back for an already-resolved dispatch (409 replay), writes nothing', async () => {
    const { env, cap } = makeEnv({
      secret: 'shhh',
      dispatches: [acmeDispatch(), acmeDispatch({ event_type: 'queue_complete' })],
    });
    const resp = await fetchInternal(env, 'acme:thread-1', goodBody, {
      'x-consumer-secret': 'shhh',
    });
    expect(resp.status).toBe(409);
    expect(cap.doFetches).toHaveLength(0);
  });

  it('rejects a forged cross-tenant write-back (dispatch under tenant A, write-back names tenant B)', async () => {
    // The dispatch exists under tenant `acme` / thread `acme:thread-1`.
    // A forged write-back addresses `evil:thread-1` (tenant `evil`) with the
    // same tool_call_id. The tenant-scoped lookup finds no dispatch for
    // tenant `evil`, so nothing is written to `evil`'s thread.
    const { env, cap } = makeEnv({ secret: 'shhh', dispatches: [acmeDispatch()] });
    const resp = await fetchInternal(env, 'evil:thread-1', goodBody, {
      'x-consumer-secret': 'shhh',
    });
    expect(resp.status).toBe(409);
    expect(cap.doFetches).toHaveLength(0);
  });

  it('rejects a write-back whose dispatch targets a different thread (409), writes nothing', async () => {
    // Dispatch is on `acme:thread-1` but the write-back addresses
    // `acme:thread-2` — same tenant, wrong thread.
    const { env, cap } = makeEnv({ secret: 'shhh', dispatches: [acmeDispatch()] });
    const resp = await fetchInternal(env, 'acme:thread-2', goodBody, {
      'x-consumer-secret': 'shhh',
    });
    expect(resp.status).toBe(409);
    expect(cap.doFetches).toHaveLength(0);
  });

  it('returns 502 when the ConversationDO write fails — no queue_complete audit emitted', async () => {
    const { env } = makeEnv({ secret: 'shhh', failDo: true, dispatches: [acmeDispatch()] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const resp = await fetchInternal(env, 'acme:thread-1', goodBody, {
      'x-consumer-secret': 'shhh',
    });
    expect(resp.status).toBe(502);
    const auditCalls = logSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes('"event_type":"queue_complete"'));
    expect(auditCalls).toHaveLength(0);
    logSpy.mockRestore();
  });
});
