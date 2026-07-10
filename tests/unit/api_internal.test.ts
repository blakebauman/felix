/**
 * Internal write-back endpoint for queue consumers. Pins:
 *
 *   1. Missing `CONSUMER_SHARED_SECRET` → 503 (refuse to authenticate
 *      anyone). Production must configure the secret.
 *   2. Missing or wrong `x-consumer-secret` → 401.
 *   3. Malformed thread_id (no `tenant:` prefix) → 400.
 *   4. Invalid body / non-tool_result events → 400.
 *   5. Happy path → forwards `tool_result` events to the ConversationDO
 *      and returns 200 with the written count.
 *   6. ConversationDO failure → 502, no audit emission.
 *   7. Successful write emits `queue_complete` audit per event, with
 *      `job_id` lifted from metadata when present.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { buildInternalRouter } from '../../src/api/internal';
import type { AuthContext } from '../../src/auth/context';
import type { Env } from '../../src/env';

interface Captured {
  doFetches: Array<{ url: string; body: string }>;
}

function makeEnv(opts: { secret?: string; failDo?: boolean }): { env: Env; cap: Captured } {
  const cap: Captured = { doFetches: [] };
  const stub = {
    async fetch(url: string, init?: RequestInit) {
      cap.doFetches.push({ url, body: String(init?.body) });
      if (opts.failDo) return new Response('DO error', { status: 500 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  };
  return {
    cap,
    env: {
      ...(opts.secret !== undefined ? { CONSUMER_SHARED_SECRET: opts.secret } : {}),
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

  it('forwards tool_result events to the ConversationDO on success', async () => {
    const { env, cap } = makeEnv({ secret: 'shhh' });
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
    // Audit emission: queue_complete with job_id from metadata.
    const auditCalls = logSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes('"event_type":"queue_complete"'));
    expect(auditCalls.length).toBeGreaterThan(0);
    expect(auditCalls[0]!).toContain('"job_id":"job-42"');
    logSpy.mockRestore();
  });

  it('returns 502 when the ConversationDO write fails — no queue_complete audit emitted', async () => {
    const { env } = makeEnv({ secret: 'shhh', failDo: true });
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
