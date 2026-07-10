/**
 * A2A JSON-RPC server.
 *
 *   POST /a2a   { jsonrpc, method, params, id }
 *
 * Methods supported:
 *   - tasks/send             → create task, run agent synchronously, persist
 *   - tasks/get              → fetch task state by id (tenant-scoped)
 *   - tasks/sendSubscribe    → create task, stream events as SSE
 *   - tasks/cancel           → mark task cancelled
 *
 * Task state lives on `A2ATaskDO` — one DO per task id, scoped by tenant.
 * Cross-tenant reads return `-32001 task not found` rather than leaking
 * existence.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { BearerSecurity, StreamEventSchema } from '../api/openapi-shared';
import type { AuthContext } from '../auth/context';
import { enforceManifestAuth } from '../auth/middleware';
import type { Env } from '../env';
import { buildAgent } from '../manifests/builder';
import { type ResolvedManifest, resolveManifest } from '../manifests/resolver';
import { getSessionStore } from '../session/do-session';
import { eventToChatMessage } from '../session/types';
import type { ToolProvider } from '../tools/provider';
import { taskDoStub } from './task-do';

// JSON-RPC envelope shared by every variant.
const JrpcEnvelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
});

const A2ATaskInput = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

const A2ATaskSendParams = z
  .object({
    task: z.object({
      id: z.string().optional(),
      manifest: z.string().optional(),
      input: A2ATaskInput,
      continuation: z.unknown().nullable().optional(),
    }),
  })
  .openapi('A2ATaskSendParams');

const A2ATaskIdParams = z.object({ id: z.string() }).openapi('A2ATaskIdParams');

const A2ARequestSchema = z
  .discriminatedUnion('method', [
    JrpcEnvelope.extend({ method: z.literal('tasks/send'), params: A2ATaskSendParams }),
    JrpcEnvelope.extend({
      method: z.literal('tasks/sendSubscribe'),
      params: A2ATaskSendParams,
    }),
    JrpcEnvelope.extend({ method: z.literal('tasks/get'), params: A2ATaskIdParams }),
    JrpcEnvelope.extend({ method: z.literal('tasks/cancel'), params: A2ATaskIdParams }),
    JrpcEnvelope.extend({ method: z.literal('tasks/resubscribe'), params: A2ATaskIdParams }),
  ])
  .openapi('A2ARequest');

const A2AResponseSchema = z
  .union([
    z.object({
      jsonrpc: z.literal('2.0'),
      id: z.union([z.number(), z.string(), z.null()]),
      result: z.unknown(),
    }),
    z.object({
      jsonrpc: z.literal('2.0'),
      id: z.union([z.number(), z.string(), z.null()]),
      error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }),
    }),
  ])
  .openapi('A2AResponse');

const a2aRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['A2A'],
  summary: 'A2A JSON-RPC entrypoint',
  description:
    'JSON-RPC 2.0 POST endpoint. The body is a discriminated union on `method`. ' +
    '`tasks/send`, `tasks/get`, `tasks/cancel` return a JSON-RPC envelope; ' +
    '`tasks/sendSubscribe` returns a `text/event-stream` of agent events.',
  security: BearerSecurity(),
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: A2ARequestSchema,
          examples: {
            tasksSend: {
              summary: 'tasks/send — synchronous task',
              value: {
                jsonrpc: '2.0',
                id: 1,
                method: 'tasks/send',
                params: {
                  task: {
                    id: 'task-001',
                    manifest: 'quick',
                    input: { messages: [{ role: 'user', content: 'ping' }] },
                  },
                },
              },
            },
            tasksSendSubscribe: {
              summary: 'tasks/sendSubscribe — SSE stream of events',
              value: {
                jsonrpc: '2.0',
                id: 2,
                method: 'tasks/sendSubscribe',
                params: {
                  task: {
                    input: { messages: [{ role: 'user', content: 'ping' }] },
                  },
                },
              },
            },
            tasksGet: {
              summary: 'tasks/get — fetch state of a previously-created task',
              value: {
                jsonrpc: '2.0',
                id: 3,
                method: 'tasks/get',
                params: { id: 'task-001' },
              },
            },
            tasksCancel: {
              summary: 'tasks/cancel — mark a task cancelled',
              value: {
                jsonrpc: '2.0',
                id: 4,
                method: 'tasks/cancel',
                params: { id: 'task-001' },
              },
            },
            tasksResubscribe: {
              summary:
                'tasks/resubscribe — reattach to a previously-created task. Replays the ' +
                'persisted session events as SSE; for completed/cancelled/failed tasks the ' +
                'stream closes after replay, for in_progress tasks the stream signals the ' +
                'client to issue a fresh tasks/sendSubscribe to continue.',
              value: {
                jsonrpc: '2.0',
                id: 5,
                method: 'tasks/resubscribe',
                params: { id: 'task-001' },
              },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: 'JSON-RPC response envelope or SSE stream (for `tasks/sendSubscribe`).',
      content: {
        'application/json': { schema: A2AResponseSchema },
        'text/event-stream': {
          schema: StreamEventSchema,
        },
      },
    },
  },
});

interface JrpcLike {
  id?: number | string | null;
}

export function buildA2ARouter(deps: { tools: ToolProvider; defaultManifest: string }) {
  // Validation failures (bad method, malformed params) translate into a
  // JSON-RPC error envelope so callers always see well-formed JSON-RPC
  // — never a raw HTTP 400 with Zod internals.
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>({
    defaultHook: (result, c) => {
      if (!result.success) {
        // Best-effort id recovery from the raw body. The harness has
        // already cloned the body for us; if anything fails we fall back
        // to null per JSON-RPC §5.
        const raw = (result as { target?: unknown }).target as JrpcLike | undefined;
        const id = typeof raw?.id === 'string' || typeof raw?.id === 'number' ? raw.id : null;
        return c.json(
          jrpcError(id ?? null, -32600, 'invalid request', result.error.message.slice(0, 500)),
        );
      }
    },
  });

  router.openapi(a2aRoute, async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    // tasks/send and tasks/sendSubscribe instantiate the manifest;
    // gate them with the manifest's inbound auth requirements. tasks/get
    // and tasks/cancel are tenant-scoped via the DO key — they still
    // need an authenticated principal so the DO key resolves to the right
    // tenant.
    if (body.method === 'tasks/send' || body.method === 'tasks/sendSubscribe') {
      const manifestName = body.params.task.manifest ?? deps.defaultManifest;
      let resolved: ResolvedManifest;
      try {
        resolved = await resolveManifest(c.env, auth.principal.tenantId, manifestName);
      } catch {
        return c.json(jrpcError(body.id, -32602, `unknown manifest ${manifestName}`));
      }
      const denied = enforceManifestAuth(c, resolved.manifest);
      if (denied) return denied as never;
    }
    try {
      switch (body.method) {
        case 'tasks/send':
          return c.json(await tasksSend(c.env, auth, body, deps));
        case 'tasks/sendSubscribe':
          return tasksSendSubscribe(c.env, auth, body, deps) as never;
        case 'tasks/get':
          return c.json(await tasksGet(c.env, auth, body));
        case 'tasks/cancel':
          return c.json(await tasksCancel(c.env, auth, body));
        case 'tasks/resubscribe':
          return tasksResubscribe(c.env, auth, body) as never;
      }
    } catch (err) {
      return c.json(jrpcError(body.id, -32000, (err as Error).message));
    }
  });

  return router;
}

function jrpcError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
} {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function jrpcResult<T>(id: number | string, result: T) {
  return { jsonrpc: '2.0' as const, id, result };
}

function safeTaskId(raw: string | undefined): string {
  if (!raw) return crypto.randomUUID();
  // Reject caller-supplied ids that contain ':' or '#' so they can't be
  // confused with our tenant-prefixed namespaces (`${tenant}:a2a-…`,
  // `${tenant}#approval-…`).
  if (/[:#]/.test(raw)) return crypto.randomUUID();
  return raw;
}

type A2ARequest = z.infer<typeof A2ARequestSchema>;
type A2ASendRequest = Extract<A2ARequest, { method: 'tasks/send' }>;
type A2ASendSubscribeRequest = Extract<A2ARequest, { method: 'tasks/sendSubscribe' }>;
type A2AIdRequest = Extract<
  A2ARequest,
  { method: 'tasks/get' | 'tasks/cancel' | 'tasks/resubscribe' }
>;

async function tasksSend(
  env: Env,
  auth: AuthContext,
  body: A2ASendRequest,
  deps: { tools: ToolProvider; defaultManifest: string },
) {
  const params = body.params;
  const taskId = safeTaskId(params.task.id);
  const manifestName = params.task.manifest ?? deps.defaultManifest;
  const stub = taskDoStub(env, auth.principal.tenantId, taskId);
  await stub.fetch('https://do/init', {
    method: 'POST',
    body: JSON.stringify({ tenantId: auth.principal.tenantId, manifestName, taskId }),
  });

  const resolved = await resolveManifest(env, auth.principal.tenantId, manifestName);
  const agent = await buildAgent(resolved.manifest, { env, tools: deps.tools, auth });
  // Use the A2A task id as the conversation thread id. A continuation
  // task replays history so a parent-task handoff resumes coherently.
  const result = await agent.invoke({
    messages: params.task.input.messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
    threadId: `${auth.principal.tenantId}:a2a-${taskId}`,
  });
  await stub.fetch('https://do/complete', {
    method: 'POST',
    body: JSON.stringify({ status: 'completed', output: { messages: result.messages } }),
  });
  return jrpcResult(body.id, {
    id: taskId,
    status: 'completed',
    output: { messages: result.messages },
    continuation: params.task.continuation ?? null,
  });
}

async function tasksSendSubscribe(
  env: Env,
  auth: AuthContext,
  body: A2ASendSubscribeRequest,
  deps: { tools: ToolProvider; defaultManifest: string },
): Promise<Response> {
  const params = body.params;
  const taskId = safeTaskId(params.task.id);
  const manifestName = params.task.manifest ?? deps.defaultManifest;
  const resolved = await resolveManifest(env, auth.principal.tenantId, manifestName);
  const agent = await buildAgent(resolved.manifest, { env, tools: deps.tools, auth });
  const threadId = `${auth.principal.tenantId}:a2a-${taskId}`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ id: taskId, status: 'in_progress' })}\n\n`),
      );
      try {
        for await (const event of agent.streamEvents({
          messages: params.task.input.messages.map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
          })),
          threadId,
        })) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ id: taskId, status: 'completed' })}\n\n`),
        );
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

async function tasksGet(env: Env, auth: AuthContext, body: A2AIdRequest) {
  const stub = taskDoStub(env, auth.principal.tenantId, body.params.id);
  const resp = await stub.fetch('https://do/get');
  if (!resp.ok) return jrpcError(body.id, -32001, 'task not found');
  return jrpcResult(body.id, await resp.json());
}

async function tasksCancel(env: Env, auth: AuthContext, body: A2AIdRequest) {
  const stub = taskDoStub(env, auth.principal.tenantId, body.params.id);
  await stub.fetch('https://do/cancel', { method: 'POST' });
  return jrpcResult(body.id, { id: body.params.id, status: 'cancelled' });
}

interface TaskStateLite {
  taskId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'failed';
  output?: { messages?: Array<{ role: string; content: string }> };
  error?: string;
}

/**
 * `tasks/resubscribe` — Anthropic's Managed Agents `wake(sessionId)` for
 * the A2A surface. The client reconnects after a network drop or worker
 * eviction; the harness replays the persisted session events back so the
 * client sees what it missed, then either closes (terminal statuses) or
 * signals that the caller should issue a fresh `tasks/sendSubscribe` with
 * the same task id to continue an in-progress run.
 *
 * The session log is the authoritative resume point. The A2ATaskDO state
 * gates whether to close or keep going. The actual continuation step
 * (re-entering the react loop from the wake point) is intentionally
 * delegated to the client's next `tasks/sendSubscribe` — Felix doesn't
 * spin up a background runner inside a Worker request, so a fresh client
 * request is the natural carrier for the next step.
 */
function tasksResubscribe(env: Env, auth: AuthContext, body: A2AIdRequest): Response {
  const tenantId = auth.principal.tenantId;
  const taskId = body.params.id;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const taskResp = await taskDoStub(env, tenantId, taskId).fetch('https://do/get');
        if (!taskResp.ok) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ id: taskId, status: 'error', error: 'task not found' })}\n\n`,
            ),
          );
          return;
        }
        const task = (await taskResp.json()) as TaskStateLite;
        // Replay persisted events. The session id matches what tasks/send
        // and tasks/sendSubscribe use for the same task.
        const session = getSessionStore(env, 'do').open(`${tenantId}:a2a-${taskId}`);
        const wake = await session.wake();
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: taskId,
              status: task.status,
              resumed_from_seq: 0,
              head_seq: wake.headSeq,
              pending_tool_calls: wake.pendingToolCalls.length,
            })}\n\n`,
          ),
        );
        const events = await session.getEvents({ kinds: ['message', 'tool_result'] });
        for (const ev of events) {
          // Render each prior turn as a `replay` event so the client can
          // distinguish replayed state from new deltas. Skip system
          // events — system prompts come from the manifest, not history.
          if (ev.role === 'system') continue;
          const message = eventToChatMessage(ev);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ event: 'replay', seq: ev.seq, message })}\n\n`,
            ),
          );
        }
        if (
          task.status === 'completed' ||
          task.status === 'cancelled' ||
          task.status === 'failed'
        ) {
          // Terminal — emit the cached final output (if any) and close.
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: taskId,
                status: task.status,
                output: task.output ?? null,
                error: task.error ?? null,
              })}\n\n`,
            ),
          );
        } else {
          // Non-terminal — signal the client to issue tasks/sendSubscribe
          // to continue from the resume point. Felix doesn't run agent
          // work in the resubscribe request itself; the client supplies
          // the next user turn (or an empty turn) and the loop picks up
          // because the same session log is the source of truth.
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: taskId,
                status: task.status,
                continue_hint:
                  'issue tasks/sendSubscribe with the same task id to continue from the resume point',
              })}\n\n`,
            ),
          );
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}
