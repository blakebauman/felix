/**
 * Felix-style REST + SSE chat endpoints.
 *
 *   POST /chat          { manifest, messages }      → sync
 *   POST /chat/stream   { manifest, messages }      → SSE
 *   GET  /chat/history/:thread_id                   → checkpointed transcript
 *   DELETE /chat/history/:thread_id                 → reset
 *
 * Thread ids are tenant-scoped server-side. The caller supplies a *suffix*
 * (the part after the tenant prefix); the effective ConversationDO id is
 * always `${authTenant}:${suffix}`. Caller-supplied suffixes that contain
 * `:` are rejected so the tenant prefix can't be smuggled away from the
 * authenticated principal.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AuthContext } from '../auth/context';
import { enforceManifestAuth, isAnonymous } from '../auth/middleware';
import { getContext } from '../context';
import type { Env } from '../env';
import { buildAgent } from '../manifests/builder';
import { type ResolvedManifest, resolveManifest } from '../manifests/resolver';
import { conversationStub } from '../memory/conversation-do';
import type { Agent } from '../patterns/types';
import { getActiveBundleVersion } from '../policy/bundle';
import { ensureFederationSynced } from '../policy/federation-do';
import type { ToolProvider } from '../tools/provider';
import {
  BearerSecurity,
  ChatMessageSchema,
  ErrorBodySchema,
  MAX_MESSAGES,
  StreamEventSchema,
} from './openapi-shared';

const SUFFIX_DELIMS = /[:#]/;

export const ChatRequestSchema = z
  .object({
    manifest: z.string().openapi({ description: 'Manifest name to invoke.', example: 'quick' }),
    messages: z.array(ChatMessageSchema).min(1).max(MAX_MESSAGES),
    thread_id: z
      .string()
      .optional()
      .openapi({
        description:
          'Optional thread-id *suffix*. The server always prefixes the tenant id; ' +
          "suffixes containing ':' or '#' are rejected.",
      }),
  })
  .strict()
  .openapi('ChatRequest', {
    example: { manifest: 'quick', messages: [{ role: 'user', content: 'What is 7 * 6?' }] },
  });

const ChatResponseSchema = z
  .object({
    messages: z.array(ChatMessageSchema),
    final: ChatMessageSchema,
    thread_id: z.string().optional(),
  })
  .openapi('ChatResponse');

export function effectiveThreadId(tenantId: string, suffix: string | undefined): string | null {
  if (!suffix) return null;
  if (SUFFIX_DELIMS.test(suffix)) return null;
  return `${tenantId}:${suffix}`;
}

const chatRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Threads'],
  summary: 'Synchronous chat invocation',
  security: BearerSecurity(),
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: ChatRequestSchema,
          examples: {
            basic: {
              summary: 'Stateless single-turn',
              value: {
                manifest: 'quick',
                messages: [{ role: 'user', content: 'What is 7 * 6?' }],
              },
            },
            withThreadId: {
              summary: 'Persist the transcript across requests',
              value: {
                manifest: 'quick',
                thread_id: 'session-1',
                messages: [{ role: 'user', content: 'And times ten?' }],
              },
            },
            assistantHistory: {
              summary: 'Replay prior turns explicitly',
              value: {
                manifest: 'quick',
                messages: [
                  { role: 'user', content: 'Pick a number between 1 and 10.' },
                  { role: 'assistant', content: 'Seven.' },
                  { role: 'user', content: 'Why?' },
                ],
              },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Final assistant message plus the resolved transcript.',
      content: { 'application/json': { schema: ChatResponseSchema } },
    },
    400: {
      description: "Bad `thread_id` (contained ':' or '#').",
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    401: {
      description: 'Manifest disallows anonymous and no valid principal was presented.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    404: {
      description: 'Unknown manifest.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    502: {
      description: 'Upstream agent/model invocation failed.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const chatStreamRoute = createRoute({
  method: 'post',
  path: '/stream',
  tags: ['Threads'],
  summary: 'Server-sent-events streaming chat invocation',
  security: BearerSecurity(),
  request: {
    body: { required: true, content: { 'application/json': { schema: ChatRequestSchema } } },
  },
  responses: {
    200: {
      description:
        'SSE stream. Each line is `data: <json>\\n\\n` where `<json>` is a `StreamEvent` ' +
        'envelope; the stream terminates with `data: [DONE]\\n\\n`. On invocation failure ' +
        'the server emits a final `{ event: "on_error" }` event before `[DONE]` so the ' +
        'client sees the cause rather than an abruptly-closed stream.',
      content: { 'text/event-stream': { schema: StreamEventSchema } },
    },
    400: {
      description: "Bad `thread_id` (contained ':' or '#').",
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    401: {
      description: 'Manifest disallows anonymous and no valid principal was presented.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    404: {
      description: 'Unknown manifest.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const ChatHistoryParams = z.object({
  thread_id: z.string().openapi({ description: 'Thread id suffix (server prefixes the tenant).' }),
});

const chatHistoryRoute = createRoute({
  method: 'get',
  path: '/history/{thread_id}',
  tags: ['Threads'],
  summary: 'Fetch the checkpointed transcript for a thread',
  security: BearerSecurity(),
  request: { params: ChatHistoryParams },
  responses: {
    200: {
      description:
        'Event slice for the thread. `events[]` carries `{ seq, ts, kind, role?, ' +
        'content?, tool_call_id?, name?, tool_calls? }`; `head` is the next ' +
        'sequence number that will be assigned.',
      content: { 'application/json': { schema: z.unknown().openapi({}) } },
    },
    400: {
      description: 'Invalid thread id suffix.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    401: {
      description: 'Anonymous callers cannot read thread history.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const chatHistoryDeleteRoute = createRoute({
  method: 'delete',
  path: '/history/{thread_id}',
  tags: ['Threads'],
  summary: 'Erase the checkpointed transcript for a thread',
  security: BearerSecurity(),
  request: { params: ChatHistoryParams },
  responses: {
    200: {
      description: 'Transcript deleted.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    400: {
      description: 'Invalid thread id suffix.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    401: {
      description: 'Anonymous callers cannot reset thread history.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

export function buildChatRouter(deps: { tools: ToolProvider }) {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
  const cache = new Map<string, Promise<Agent>>();

  async function getAgent(env: Env, resolved: ResolvedManifest): Promise<Agent> {
    // Mirror the active federation bundle into this isolate before keying the
    // cache so a refresh invalidates agents compiled against a stale bundle
    // (otherwise a per-isolate agent cache would pin the old governance until
    // the isolate recycles).
    await ensureFederationSynced(env);
    const key = `${resolved.cacheKey}#fb:${getActiveBundleVersion() ?? '-'}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = buildAgent(resolved.manifest, { env, tools: deps.tools });
      cache.set(key, pending);
    }
    return pending;
  }

  function resolveThread(
    auth: AuthContext,
    raw: string | undefined,
  ): { id: string | undefined; rejection?: Response } {
    if (raw == null) return { id: undefined };
    if (SUFFIX_DELIMS.test(raw)) {
      return {
        id: undefined,
        rejection: new Response(
          JSON.stringify({
            error: 'invalid_thread_id',
            detail: "thread_id may not contain ':' or '#'",
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      };
    }
    return { id: `${auth.principal.tenantId}:${raw}` };
  }

  router.openapi(chatRoute, async (c) => {
    const body = c.req.valid('json');
    const auth = c.get('auth');
    // Resolve the thread id first — it doubles as the deterministic
    // bucket key for canary routing inside `resolveManifest`.
    const { id: threadId, rejection } = resolveThread(auth, body.thread_id);
    if (rejection) return rejection as never;
    let resolved: ResolvedManifest;
    try {
      resolved = await resolveManifest(c.env, auth.principal.tenantId, body.manifest, {
        ...(threadId ? { threadId } : {}),
      });
    } catch {
      return c.json({ error: 'unknown_manifest', detail: body.manifest }, 404);
    }
    const denied = enforceManifestAuth(c, resolved.manifest);
    if (denied) return denied as never;
    if (resolved.variant) {
      c.header('x-manifest-variant', resolved.variant);
      const rc = getContext();
      if (rc) rc.manifestVariant = resolved.variant;
    }
    const agent = await getAgent(c.env, resolved);
    let result: Awaited<ReturnType<Agent['invoke']>>;
    try {
      result = await agent.invoke({ messages: body.messages, threadId });
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 500);
      console.error('chat invoke failed', message);
      return c.json({ error: 'invocation_failed', detail: message }, 502);
    }
    return c.json(
      { messages: result.messages, final: result.final, thread_id: body.thread_id },
      200,
    );
  });

  router.openapi(chatStreamRoute, async (c) => {
    const body = c.req.valid('json');
    const auth = c.get('auth');
    const { id: threadId, rejection } = resolveThread(auth, body.thread_id);
    if (rejection) return rejection as never;
    let resolved: ResolvedManifest;
    try {
      resolved = await resolveManifest(c.env, auth.principal.tenantId, body.manifest, {
        ...(threadId ? { threadId } : {}),
      });
    } catch {
      return c.json({ error: 'unknown_manifest', detail: body.manifest }, 404);
    }
    const denied = enforceManifestAuth(c, resolved.manifest);
    if (denied) return denied as never;
    if (resolved.variant) {
      c.header('x-manifest-variant', resolved.variant);
      const rc = getContext();
      if (rc) rc.manifestVariant = resolved.variant;
    }
    const agent = await getAgent(c.env, resolved);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of agent.streamEvents({
            messages: body.messages,
            threadId,
          })) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
        } catch (err) {
          const message = String((err as Error)?.message ?? err).slice(0, 500);
          console.error('chat.stream invoke failed', message);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ event: 'on_error', data: { message } })}\n\n`),
          );
        } finally {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
    });
    // The streaming Response is constructed fresh, so headers set via
    // `c.header(...)` (e.g. x-manifest-variant) don't carry over — set them
    // here explicitly or the client never sees the canary variant.
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        ...(resolved.variant ? { 'x-manifest-variant': resolved.variant } : {}),
      },
    }) as never;
  });

  router.openapi(chatHistoryRoute, async (c) => {
    const auth = c.get('auth');
    if (isAnonymous(auth)) return c.json({ error: 'unauthorized' }, 401);
    const { thread_id } = c.req.valid('param');
    const { id: threadId, rejection } = resolveThread(auth, thread_id);
    if (rejection) return rejection as never;
    if (!threadId) return c.json({ error: 'invalid_thread_id' }, 400);
    const stub = conversationStub(c.env, threadId);
    const resp = await stub.fetch('https://do/events');
    return c.json((await resp.json()) as unknown, 200);
  });

  router.openapi(chatHistoryDeleteRoute, async (c) => {
    const auth = c.get('auth');
    if (isAnonymous(auth)) return c.json({ error: 'unauthorized' }, 401);
    const { thread_id } = c.req.valid('param');
    const { id: threadId, rejection } = resolveThread(auth, thread_id);
    if (rejection) return rejection as never;
    if (!threadId) return c.json({ error: 'invalid_thread_id' }, 400);
    const stub = conversationStub(c.env, threadId);
    await stub.fetch('https://do/events', { method: 'DELETE' });
    return c.json({ ok: true as const }, 200);
  });

  return router;
}
