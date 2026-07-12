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

import { beforeEach, describe, expect, it } from 'vitest';
import { buildA2ARouter } from '../../src/a2a/server';
import { ANONYMOUS, type AuthContext } from '../../src/auth/context';
import type { Env } from '../../src/env';
import { loadManifest } from '../../src/manifests/loader';
import { _clearResolverCache } from '../../src/manifests/resolver';
import type { Manifest } from '../../src/manifests/schema';
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

/**
 * Minimal D1 stub serving the tenant-D1 manifest resolution path
 * (`manifest_active` pointer + `manifests` version blob) for a small,
 * name-keyed set of seeded manifests. Names not in the map fall through
 * (returns null), so the resolver drops to the bundled layer — that's how
 * the existing `quick` (allow_anonymous) manifest keeps resolving.
 */
function fakeDb(manifests: Map<string, Manifest>): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (sql.includes('FROM manifest_active')) {
                const name = args[1] as string;
                if (!manifests.has(name)) return null;
                return {
                  version: 1,
                  canary_version: null,
                  canary_weight: 0,
                  updated_at: 0,
                  updated_by: 'test',
                } as T;
              }
              if (sql.includes('FROM manifests')) {
                const name = args[1] as string;
                const version = args[2] as number;
                const m = manifests.get(name);
                if (!m || version !== 1) return null;
                return {
                  manifest_json: JSON.stringify(m),
                  created_at: 0,
                  created_by: 'test',
                  comment: '',
                } as T;
              }
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function fakeEnv(
  seed: {
    tasks?: Map<string, TaskState>;
    events?: Map<string, SessionEvent[]>;
    manifests?: Map<string, Manifest>;
  } = {},
): Env {
  const tasks = seed.tasks ?? new Map<string, TaskState>();
  const events = seed.events ?? new Map<string, SessionEvent[]>();
  const manifests = seed.manifests ?? new Map<string, Manifest>();

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
    DB: fakeDb(manifests),
    // No R2 overrides in these tests — force the resolver past the tenant/
    // global R2 layers to D1 (seeded) or bundled.
    BUNDLES: { get: async () => null },
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

// The A2A router's read handlers read auth from c.get('auth'), which the
// harness's authMiddleware populates. In a unit test we boot a small
// wrapping app that installs auth synchronously, mounts the A2A router, and
// lets us drive the response through `app.fetch`.
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

// Manifest resolution is cached per isolate; reset between tests so a seeded
// manifest in one test doesn't leak into another.
beforeEach(() => _clearResolverCache());

describe('a2a tasks/resubscribe', () => {
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

/**
 * Read/mutate methods (tasks/get, tasks/cancel, tasks/resubscribe) are gated
 * by the inbound auth of the manifest that OWNS the task — the same gate
 * tasks/send uses. A task created under a manifest that disallows anonymous
 * must not be readable by an anonymous caller, even though (in an anonymous
 * public deployment) both callers share tenant `default` and can reach the
 * same DO. A manifest that opts into anonymous still permits anonymous reads.
 */
describe('a2a read-method auth gating', () => {
  // A manifest that disallows anonymous inbound callers.
  function lockedManifest(): Manifest {
    const m = structuredClone(loadManifest('quick'));
    m.metadata.name = 'locked';
    m.spec.auth.inbound.allow_anonymous = false;
    return m;
  }

  function seedLockedTask(tenantId: string, taskId: string) {
    const tasks = new Map<string, TaskState>([
      [
        `${tenantId}#${taskId}`,
        {
          taskId,
          tenantId,
          manifestName: 'locked',
          status: 'completed',
          createdAt: 0,
          updatedAt: 1,
          output: { messages: [{ role: 'assistant', content: 'secret' }] },
        },
      ],
    ]);
    const events = new Map<string, SessionEvent[]>([
      [
        `${tenantId}:a2a-${taskId}`,
        [{ seq: 0, ts: 0, kind: 'message', role: 'user', content: 'private' }],
      ],
    ]);
    const manifests = new Map<string, Manifest>([['locked', lockedManifest()]]);
    return { tasks, events, manifests };
  }

  function rpc(method: string, id: string) {
    return new Request('https://t/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { id } }),
    });
  }

  it('rejects an anonymous tasks/get against a non-anonymous manifest', async () => {
    const env = fakeEnv(seedLockedTask('default', 'locked-task'));
    const app = await bootApp(ANONYMOUS);
    const resp = await app.fetch(rpc('tasks/get', 'locked-task'), env);
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error?: string };
    expect(body.error).toBe('unauthorized');
  });

  it('rejects an anonymous tasks/resubscribe against a non-anonymous manifest', async () => {
    const env = fakeEnv(seedLockedTask('default', 'locked-task'));
    const app = await bootApp(ANONYMOUS);
    const resp = await app.fetch(rpc('tasks/resubscribe', 'locked-task'), env);
    expect(resp.status).toBe(401);
    // Crucially, no replay of the private transcript leaks out.
    const text = await resp.text();
    expect(text).not.toContain('private');
  });

  it('rejects an anonymous tasks/cancel against a non-anonymous manifest', async () => {
    const env = fakeEnv(seedLockedTask('default', 'locked-task'));
    const app = await bootApp(ANONYMOUS);
    const resp = await app.fetch(rpc('tasks/cancel', 'locked-task'), env);
    expect(resp.status).toBe(401);
  });

  it('allows an authenticated same-tenant tasks/get against a non-anonymous manifest', async () => {
    const env = fakeEnv(seedLockedTask('default', 'locked-task'));
    const app = await bootApp(authedTenant('default'));
    const resp = await app.fetch(rpc('tasks/get', 'locked-task'), env);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { result?: { manifestName?: string; status?: string } };
    expect(body.result).toMatchObject({ manifestName: 'locked', status: 'completed' });
  });

  it('still allows an anonymous tasks/get when the owning manifest opts into anonymous', async () => {
    // `quick` (bundled) has allow_anonymous: true — anonymous reads are OK by design.
    const tenantId = 'default';
    const taskId = 'open-task';
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
        },
      ],
    ]);
    const env = fakeEnv({ tasks });
    const app = await bootApp(ANONYMOUS);
    const resp = await app.fetch(rpc('tasks/get', taskId), env);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { result?: { manifestName?: string } };
    expect(body.result).toMatchObject({ manifestName: 'quick' });
  });

  it('does not leak existence of another tenant’s task (tasks/get → -32001)', async () => {
    // Task lives under tenant `acme`; a caller in tenant `other` misses the DO.
    const env = fakeEnv(seedLockedTask('acme', 'locked-task'));
    const app = await bootApp(authedTenant('other'));
    const resp = await app.fetch(rpc('tasks/get', 'locked-task'), env);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { error?: { code: number; message: string } };
    expect(body.error).toMatchObject({ code: -32001, message: 'task not found' });
  });
});
