/**
 * A2A `tasks/resubscribe` — the wake-driven reattach surface. Builds a
 * fake env with in-memory `A2A_TASK_DO` and `CONVERSATION_DO` bindings,
 * boots the A2A router, and inspects the SSE stream the route returns.
 *
 * Three contracts pinned:
 *
 *   1. Task that doesn't exist for this tenant returns a single
 *      `status: 'error'` SSE event and closes (no leakage of cross-tenant
 *      existence).
 *   2. Task that completed replays its persisted session events as
 *      `event: 'replay'` rows, then emits the cached output, then closes.
 *   3. Task that's still in_progress replays events then signals the
 *      client to issue tasks/sendSubscribe — Felix doesn't spin background
 *      work inside the resubscribe request itself.
 */

import { describe, expect, it } from 'vitest';
import { buildA2ARouter } from '../../src/a2a/server';
import { ANONYMOUS, type AuthContext } from '../../src/auth/context';
import type { Env } from '../../src/env';
import type { SessionEvent } from '../../src/session/types';
import { InMemoryToolProvider } from '../../src/tools/provider';

interface TaskState {
  taskId: string;
  tenantId: string;
  manifestName: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'failed';
  createdAt: number;
  updatedAt: number;
  output?: { messages?: Array<{ role: string; content: string }> };
  error?: string;
}

function fakeEnv(
  seed: { tasks?: Map<string, TaskState>; events?: Map<string, SessionEvent[]> } = {},
): Env {
  const tasks = seed.tasks ?? new Map<string, TaskState>();
  const events = seed.events ?? new Map<string, SessionEvent[]>();

  const taskStub = (key: string) => ({
    fetch: async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/get') {
        const t = tasks.get(key);
        if (!t) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(t));
      }
      return new Response('not found', { status: 404 });
    },
  });
  const eventStub = (key: string) => ({
    fetch: async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/events' && (u.search === '' || u.searchParams.size === 0)) {
        return new Response(
          JSON.stringify({ events: events.get(key) ?? [], head: (events.get(key) ?? []).length }),
        );
      }
      if (u.pathname === '/events') {
        // kinds-filtered read (used by tasksResubscribe).
        const kinds = (u.searchParams.get('kinds') ?? '').split(',').filter(Boolean);
        const filtered = (events.get(key) ?? []).filter((e) =>
          kinds.length ? kinds.includes(e.kind) : true,
        );
        return new Response(JSON.stringify({ events: filtered, head: filtered.length }));
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    A2A_TASK_DO: {
      idFromName: (name: string) => name,
      get: (id: unknown) => taskStub(String(id)),
    },
    CONVERSATION_DO: {
      idFromName: (name: string) => name,
      get: (id: unknown) => eventStub(String(id)),
    },
  } as unknown as Env;
}

function authedTenant(tenantId: string): AuthContext {
  return {
    ...ANONYMOUS,
    principal: { ...ANONYMOUS.principal, tenantId, subject: `${tenantId}:user`, issuer: 'test' },
  };
}

async function readSse(resp: Response): Promise<Array<Record<string, unknown>>> {
  const text = await resp.text();
  const rows = text
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('data: '))
    .map((b) => b.slice('data: '.length));
  return rows.map((r) => JSON.parse(r) as Record<string, unknown>);
}

describe('a2a tasks/resubscribe', () => {
  // The A2A router's resubscribe handler reads auth from c.get('auth'),
  // which the harness's authMiddleware populates. In a unit test we boot
  // a small wrapping app that installs auth synchronously, mounts the
  // A2A router, and lets us drive the SSE response through `app.fetch`.
  async function bootApp(auth: AuthContext) {
    const { OpenAPIHono } = await import('@hono/zod-openapi');
    const app = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
    app.use('*', async (c, next) => {
      c.set('auth', auth);
      await next();
    });
    app.route(
      '/a2a',
      buildA2ARouter({ tools: new InMemoryToolProvider(), defaultManifest: 'quick' }),
    );
    return app;
  }

  it('returns an error SSE event when the task does not exist', async () => {
    const env = fakeEnv();
    const auth = authedTenant('acme');
    const app = await bootApp(auth);
    const resp = await app.fetch(
      new Request('https://t/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/resubscribe',
          params: { id: 'ghost-task' },
        }),
      }),
      env,
    );
    expect(resp.headers.get('content-type')).toMatch(/text\/event-stream/);
    const events = await readSse(resp);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'ghost-task', status: 'error', error: 'task not found' });
  });

  it('replays events and emits cached output for a completed task', async () => {
    const tenantId = 'acme';
    const taskId = 'done-task';
    const sessionKey = `${tenantId}:a2a-${taskId}`;
    const tasks = new Map<string, TaskState>([
      [
        `${tenantId}#${taskId}`,
        {
          taskId,
          tenantId,
          manifestName: 'quick',
          status: 'completed',
          createdAt: 0,
          updatedAt: 1,
          output: { messages: [{ role: 'assistant', content: 'done' }] },
        },
      ],
    ]);
    const events = new Map<string, SessionEvent[]>([
      [
        sessionKey,
        [
          { seq: 0, ts: 0, kind: 'message', role: 'user', content: 'hi' },
          { seq: 1, ts: 1, kind: 'message', role: 'assistant', content: 'done' },
        ],
      ],
    ]);
    const env = fakeEnv({ tasks, events });
    const auth = authedTenant(tenantId);
    const app = await bootApp(auth);
    const resp = await app.fetch(
      new Request('https://t/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/resubscribe',
          params: { id: taskId },
        }),
      }),
      env,
    );
    const ssePayloads = await readSse(resp);
    // First event is the status preamble; then two replay events; then the terminal output.
    expect(ssePayloads[0]).toMatchObject({ id: taskId, status: 'completed', head_seq: 2 });
    expect(ssePayloads[1]).toMatchObject({ event: 'replay', seq: 0 });
    expect(ssePayloads[2]).toMatchObject({ event: 'replay', seq: 1 });
    const last = ssePayloads[ssePayloads.length - 1];
    expect(last).toMatchObject({
      id: taskId,
      status: 'completed',
      output: { messages: [{ role: 'assistant', content: 'done' }] },
    });
  });

  it('emits continue_hint for an in_progress task so the client can call tasks/sendSubscribe', async () => {
    const tenantId = 'acme';
    const taskId = 'paused-task';
    const tasks = new Map<string, TaskState>([
      [
        `${tenantId}#${taskId}`,
        {
          taskId,
          tenantId,
          manifestName: 'quick',
          status: 'in_progress',
          createdAt: 0,
          updatedAt: 1,
        },
      ],
    ]);
    const events = new Map<string, SessionEvent[]>([
      [
        `${tenantId}:a2a-${taskId}`,
        [
          { seq: 0, ts: 0, kind: 'message', role: 'user', content: 'kick off' },
          {
            seq: 1,
            ts: 1,
            kind: 'message',
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'tc1', name: 'calc', args: { expr: '2+2' } }],
          },
        ],
      ],
    ]);
    const env = fakeEnv({ tasks, events });
    const auth = authedTenant(tenantId);
    const app = await bootApp(auth);
    const resp = await app.fetch(
      new Request('https://t/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/resubscribe',
          params: { id: taskId },
        }),
      }),
      env,
    );
    const ssePayloads = await readSse(resp);
    // Preamble should report a pending tool call detected by wake().
    expect(ssePayloads[0]).toMatchObject({
      id: taskId,
      status: 'in_progress',
      pending_tool_calls: 1,
      head_seq: 2,
    });
    const last = ssePayloads[ssePayloads.length - 1];
    expect(last).toMatchObject({
      id: taskId,
      status: 'in_progress',
    });
    expect(String(last?.continue_hint)).toContain('tasks/sendSubscribe');
  });
});
