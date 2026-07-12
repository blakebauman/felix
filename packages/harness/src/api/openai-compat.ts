/**
 * OpenAI-compatible chat completions endpoint.
 *
 * - `GET  /v1/models`            → one model entry per bundled manifest
 * - `POST /v1/chat/completions`  → sync or SSE stream
 *
 * Tool calls on the final assistant message are translated into OpenAI's
 * `tool_calls` shape so SDK clients see the envelope they expect.
 *
 * Threading: callers MAY supply `x-thread-id` as a *suffix*. The server
 * always prefixes the authenticated tenant id so a caller cannot mount
 * another tenant's conversation (or another tenant's A2A task). Suffixes
 * containing `:` are rejected.
 *
 * Routes are registered through `@hono/zod-openapi` so the surface is
 * surfaced in `/openapi.json` and the Scalar UI at `/docs`.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AuthContext } from '../auth/context';
import { enforceManifestAuth } from '../auth/middleware';
import { getContext } from '../context';
import type { Env } from '../env';
import { buildAgent } from '../manifests/builder';
import { listManifests } from '../manifests/loader';
import { type ResolvedManifest, resolveManifest } from '../manifests/resolver';
import type { Agent, ChatMessage } from '../patterns/types';
import { getActiveBundleVersion } from '../policy/bundle';
import { ensureFederationSynced } from '../policy/federation-do';
import type { ToolProvider } from '../tools/provider';
import { MAX_MESSAGE_CHARS, MAX_MESSAGES } from './openapi-shared';

// -----------------------------------------------------------------------------
// Schemas (also become components in /openapi.json via .openapi(<name>))
// -----------------------------------------------------------------------------

const ChatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(MAX_MESSAGE_CHARS),
  })
  .openapi('ChatMessage', {
    example: { role: 'user', content: 'What is 7 * 6?' },
  });

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string().openapi({
      description: 'Manifest name (see GET /v1/models).',
      example: 'quick',
    }),
    messages: z.array(ChatMessageSchema).min(1).max(MAX_MESSAGES),
    stream: z.boolean().optional().openapi({
      description: 'Emit `text/event-stream` chunks instead of a single JSON response.',
      example: false,
    }),
    temperature: z.number().optional().openapi({ example: 0 }),
    max_tokens: z.number().int().positive().optional().openapi({ example: 1024 }),
  })
  .openapi('ChatCompletionRequest', {
    example: {
      model: 'quick',
      messages: [{ role: 'user', content: 'What is 7 * 6?' }],
    },
  });

const ToolCallSchema = z
  .object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.string() }),
  })
  .openapi('ToolCall');

const ChatCompletionResponseSchema = z
  .object({
    id: z.string().openapi({
      readOnly: true,
      example: 'chatcmpl-7c2a4e7e-4b2a-4c2a-9b2a-4b2a4c2a9b2a',
    }),
    object: z.literal('chat.completion').openapi({ readOnly: true }),
    created: z
      .number()
      .int()
      .openapi({ readOnly: true, example: 1747100000, description: 'Unix timestamp (seconds).' }),
    model: z
      .string()
      .openapi({ readOnly: true, example: 'quick', description: 'Echo of the request `model`.' }),
    choices: z.array(
      z.object({
        index: z.number().int().openapi({ readOnly: true }),
        message: z.object({
          role: z.literal('assistant'),
          content: z.string(),
          tool_calls: z.array(ToolCallSchema).optional(),
        }),
        finish_reason: z
          .string()
          .openapi({ readOnly: true, example: 'stop', description: '`stop` or `tool_calls`.' }),
      }),
    ),
    usage: z
      .object({
        prompt_tokens: z.number().int(),
        completion_tokens: z.number().int(),
        total_tokens: z.number().int(),
      })
      .openapi({ readOnly: true, description: 'Cumulative token usage for this completion.' }),
  })
  .openapi('ChatCompletionResponse', {
    example: {
      id: 'chatcmpl-7c2a4e7e-4b2a-4c2a-9b2a-4b2a4c2a9b2a',
      object: 'chat.completion',
      created: 1747100000,
      model: 'quick',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '7 * 6 = 42.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 412, completion_tokens: 9, total_tokens: 421 },
    },
  });

const ModelListResponseSchema = z
  .object({
    object: z.literal('list'),
    data: z.array(
      z.object({
        id: z.string(),
        object: z.literal('model'),
        created: z.number().int(),
        owned_by: z.string(),
      }),
    ),
  })
  .openapi('ModelList', {
    example: {
      object: 'list',
      data: [{ id: 'quick', object: 'model', created: 0, owned_by: 'orchestrator' }],
    },
  });

const ErrorResponseSchema = z
  .object({ error: z.object({ message: z.string() }) })
  .openapi('ErrorResponse', {
    example: { error: { message: 'Unknown model/manifest: foo' } },
  });

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

const listModelsRoute = createRoute({
  method: 'get',
  path: '/models',
  tags: ['OpenAI'],
  summary: 'List available manifests as OpenAI models',
  responses: {
    200: {
      description: 'One model entry per bundled manifest.',
      content: { 'application/json': { schema: ModelListResponseSchema } },
    },
  },
});

const chatCompletionsRoute = createRoute({
  method: 'post',
  path: '/chat/completions',
  tags: ['OpenAI'],
  summary: 'OpenAI-compatible chat completion',
  description:
    'Synchronous (default) or SSE stream when `stream: true`. **Each request is ' +
    'stateless by default** — unlike the OpenAI hosted API, no server-side ' +
    'conversation memory is retained unless the caller opts in by supplying ' +
    '`x-thread-id`. With the header set, the value is used as a *suffix* under ' +
    "the authenticated tenant; suffixes containing ':' or '#' are rejected to " +
    'prevent tenant-prefix smuggling.',
  request: {
    headers: z.object({
      'x-thread-id': z.string().optional().openapi({
        description: 'Optional thread-id suffix; tenant prefix is enforced server-side.',
      }),
    }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: ChatCompletionRequestSchema,
          examples: {
            basic: {
              summary: 'Single-turn user message',
              value: {
                model: 'quick',
                messages: [{ role: 'user', content: 'What is 7 * 6?' }],
              },
            },
            withSystemPrompt: {
              summary: 'Override the system prompt for one call',
              value: {
                model: 'quick',
                messages: [
                  { role: 'system', content: 'Respond only in haiku.' },
                  { role: 'user', content: 'Describe autumn.' },
                ],
              },
            },
            streaming: {
              summary: 'Server-sent events — `text/event-stream` response',
              value: {
                model: 'quick',
                stream: true,
                messages: [{ role: 'user', content: 'Tell me a short story.' }],
              },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Synchronous completion or SSE stream (text/event-stream).',
      content: {
        'application/json': {
          schema: ChatCompletionResponseSchema,
          examples: {
            basic: {
              summary: 'Plain text reply',
              value: {
                id: 'chatcmpl-7c2a4e7e-4b2a-4c2a-9b2a-4b2a4c2a9b2a',
                object: 'chat.completion',
                created: 1747100000,
                model: 'quick',
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: '7 * 6 = 42.' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
              },
            },
            withToolCalls: {
              summary: 'Assistant calls a tool — `finish_reason: tool_calls`',
              value: {
                id: 'chatcmpl-7c2a4e7e-4b2a-4c2a-9b2a-4b2a4c2a9b2a',
                object: 'chat.completion',
                created: 1747100000,
                model: 'quick',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: '',
                      tool_calls: [
                        {
                          id: 'call_abc',
                          type: 'function',
                          function: {
                            name: 'calculator',
                            arguments: '{"expression":"7*6"}',
                          },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 },
              },
            },
          },
        },
      },
    },
    400: {
      description: 'Invalid `x-thread-id` header.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Manifest disallows anonymous and no valid principal was presented.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Unknown model/manifest.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    502: {
      description: 'Upstream agent/model invocation failed (gateway error, model timeout, etc).',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export function buildOpenAIRouter(deps: { tools: ToolProvider }) {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
  const cache = new Map<string, Promise<Agent>>();

  async function getAgent(env: Env, resolved: ResolvedManifest): Promise<Agent> {
    // See chat.ts:getAgent — fold the active federation bundle version into
    // the cache key so a refresh invalidates stale-governance agents.
    await ensureFederationSynced(env);
    const key = `${resolved.cacheKey}#fb:${getActiveBundleVersion() ?? '-'}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = buildAgent(resolved.manifest, { env, tools: deps.tools });
      cache.set(key, pending);
    }
    return pending;
  }

  router.openapi(listModelsRoute, (c) => {
    return c.json(
      {
        object: 'list' as const,
        data: listManifests().map((id) => ({
          id,
          object: 'model' as const,
          created: 0,
          owned_by: 'orchestrator',
        })),
      },
      200,
    );
  });

  router.openapi(chatCompletionsRoute, async (c) => {
    const body = c.req.valid('json');
    const auth = c.get('auth');

    // Optional pinning header for canary / diagnostic. Only meaningful
    // against a managed tenant's D1 versions; the resolver throws when a
    // pin lands on an anonymous tenant or unknown version.
    const pinHeader = c.req.header('x-manifest-version');
    const pinVersion = pinHeader ? Number(pinHeader) : undefined;
    if (pinHeader && (!Number.isInteger(pinVersion) || pinVersion! < 1)) {
      return c.json({ error: { message: 'x-manifest-version must be a positive integer' } }, 400);
    }

    // Thread namespace: caller-supplied `x-thread-id` is treated as a
    // *suffix* under the authenticated tenant. Reject ':' / '#' so the
    // prefix can't be smuggled away from the tenant id. Resolved before
    // `resolveManifest` so it can seed the deterministic canary bucket
    // — a single thread stays on one variant across the rollout.
    const suffix = c.req.header('x-thread-id');
    if (suffix && /[:#]/.test(suffix)) {
      return c.json({ error: { message: "x-thread-id may not contain ':' or '#'" } }, 400);
    }
    const threadIdForResolve = suffix ? `${auth.principal.tenantId}:${suffix}` : undefined;

    let resolved: ResolvedManifest;
    try {
      resolved = await resolveManifest(c.env, auth.principal.tenantId, body.model, {
        pinVersion,
        ...(threadIdForResolve ? { threadId: threadIdForResolve } : {}),
      });
    } catch {
      return c.json({ error: { message: `Unknown model/manifest: ${body.model}` } }, 404);
    }
    const denied = enforceManifestAuth(c, resolved.manifest);
    if (denied) return denied as never;
    if (resolved.variant) {
      c.header('x-manifest-variant', resolved.variant);
      const rc = getContext();
      if (rc) rc.manifestVariant = resolved.variant;
    }

    let agent: Agent;
    try {
      agent = await getAgent(c.env, resolved);
    } catch {
      return c.json({ error: { message: `Unknown model/manifest: ${body.model}` } }, 404);
    }
    const messages = body.messages.map(
      (m): ChatMessage => ({
        role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
        content: m.content,
      }),
    );

    const threadId = `${auth.principal.tenantId}:${suffix ?? `openai-${crypto.randomUUID()}`}`;

    // Cumulative token usage for this request — the model client accrues
    // into this same object on every call, so reading it after invoke()
    // (or at stream end) yields the whole turn including tool-loop steps.
    const tokens = getContext()?.limitState.tokens;

    if (body.stream) {
      return streamResponse(agent, messages, body.model, threadId, tokens) as never;
    }

    let result: Awaited<ReturnType<Agent['invoke']>>;
    try {
      result = await agent.invoke({ messages, threadId });
    } catch (err) {
      // Surface model/gateway/binding failures as structured OpenAI-shaped
      // errors instead of bare Hono 500s. The message is short by intent
      // — no internal stack traces or upstream URLs back to the caller.
      const message = String((err as Error)?.message ?? err).slice(0, 500);
      console.error('chat.completions invoke failed', message);
      return c.json({ error: { message: `agent invocation failed: ${message}` } }, 502);
    }
    const tool_calls = translateToolCalls(result.final.tool_calls);
    const message: { role: 'assistant'; content: string; tool_calls?: typeof tool_calls } = {
      role: 'assistant',
      content: result.final.content,
    };
    let finish_reason = 'stop';
    if (tool_calls) {
      message.tool_calls = tool_calls;
      finish_reason = 'tool_calls';
    }
    return c.json(
      {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion' as const,
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message, finish_reason }],
        usage: toUsage(tokens),
      },
      200,
    );
  });

  return router;
}

function translateToolCalls(
  raw: ChatMessage['tool_calls'],
):
  | Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((c) => ({
    id: c.id,
    type: 'function' as const,
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  }));
}

/** Map the request's cumulative `limitState.tokens` to OpenAI usage shape. */
function toUsage(tokens: { input: number; output: number } | undefined): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const input = tokens?.input ?? 0;
  const output = tokens?.output ?? 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

function streamResponse(
  agent: Agent,
  messages: ChatMessage[],
  modelName: string,
  threadId: string,
  tokens?: { input: number; output: number },
): Response {
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  function chunk(delta: object, finish?: string): Uint8Array {
    const payload: Record<string, unknown> = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: modelName,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    };
    // Terminal chunk carries the turn's cumulative usage — `tokens` is the
    // request's live limitState accumulator, so by stream end it holds every
    // model call of the tool loop.
    if (finish) payload.usage = toUsage(tokens);
    return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  }
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(chunk({ role: 'assistant' }));
      try {
        for await (const event of agent.streamEvents({ messages, threadId })) {
          if (event.event === 'on_chat_model_stream') {
            const text = event.data.chunk.content;
            if (text) controller.enqueue(chunk({ content: text }));
          }
        }
        controller.enqueue(chunk({}, 'stop'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        controller.enqueue(chunk({ content: `[stream error] ${(err as Error).message}` }, 'stop'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    },
  });
}
