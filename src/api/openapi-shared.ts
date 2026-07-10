/**
 * Cross-router OpenAPI helpers.
 *
 * Importing `z` from `@hono/zod-openapi` (which is plain Zod with the
 * `.openapi()` augmentation already applied) keeps consumer files free
 * of "extend the prototype" side-effect imports.
 *
 * Everything here is intentionally tiny — schemas/values that recur
 * across every router land in this file so router files stay focused on
 * their own routes.
 */

import { z } from '@hono/zod-openapi';

/**
 * Canonical error envelope used by `/audit`, `/approvals`, `/plans`,
 * `/jobs`, `/manifests`. The OpenAI-compat router uses its own
 * `{ error: { message } }` shape (kept separate so SDK clients keep
 * working).
 */
export const ErrorBodySchema = z
  .object({
    error: z.string().openapi({ example: 'not_found' }),
    detail: z.string().optional().openapi({ example: 'unknown manifest' }),
  })
  .openapi('ErrorBody');

/**
 * Bearer security marker. Attach via `security: BearerSecurity()` on any
 * route that requires an authenticated principal. The `bearerAuth`
 * component is registered in `src/app.ts`.
 *
 * Returned as a fresh array so route definitions hold their own mutable
 * `SecurityRequirementObject[]` — `as const` here breaks `createRoute`'s
 * type inference for `request.query` / `request.params`.
 */
export const BearerSecurity = (): Array<{ bearerAuth: string[] }> => [{ bearerAuth: [] }];

/**
 * Shared `?limit=` pagination. `z.coerce.number()` is critical here:
 * query params arrive as strings, so a plain `z.number()` rejects every
 * inbound request.
 */
export const PaginatedQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .openapi({ description: 'Page size (1–500).', example: 100 }),
});

/**
 * Inbound request bounds for the public chat surfaces. Without these a single
 * request can carry millions of large messages — JSON-parse memory blowup,
 * unbounded ConversationDO appends, and uncapped model spend — all *before*
 * the limits wrapper fires. Mirrors the `.max(...)` discipline already used by
 * the manifests / approvals / audit schemas.
 */
export const MAX_MESSAGE_CHARS = 256 * 1024; // 256 KB per message
export const MAX_MESSAGES = 500; // messages per request
export const MAX_ATTACHMENTS = 6; // image attachments per message
export const MAX_ATTACHMENT_URL_CHARS = 10 * 1024 * 1024; // ~10 MB base64 data URL

/**
 * An image attached to a user message. Carries either a base64 `data:` URL
 * (the browser composer inlines the file) or a remote `https://` URL; the
 * model adapter maps it to a provider-native image block. Bounded so a single
 * request can't blow up JSON-parse memory before the limits wrapper fires.
 */
export const ImageAttachmentSchema = z
  .object({
    url: z.string().max(MAX_ATTACHMENT_URL_CHARS),
    media_type: z.string().max(256),
    filename: z.string().max(1024).optional(),
  })
  .openapi('ImageAttachment', {
    example: { url: 'data:image/png;base64,iVBORw0KG…', media_type: 'image/png' },
  });

/**
 * OpenAI-compatible message shape. Promoted here from `openai-compat.ts`
 * so `/chat/*` can reference the same component without duplicating it.
 * `attachments` is a Felix extension for multimodal (vision) input.
 */
export const ChatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(MAX_MESSAGE_CHARS),
    attachments: z.array(ImageAttachmentSchema).max(MAX_ATTACHMENTS).optional(),
  })
  .openapi('ChatMessage', {
    example: { role: 'user', content: 'What is 7 * 6?' },
  });

/**
 * Canonical SSE event envelope yielded by `agent.streamEvents()`. Used by
 * `/chat/stream` and A2A `tasks/sendSubscribe`. The wire format is one
 * `data: <json>\n\n` line per event, terminated by `data: [DONE]\n\n`.
 *
 * Scalar can't render JSON Schema inside a `text/event-stream` response,
 * so each SSE route declares its 200 schema as `z.string()` and links to
 * this component in its description.
 */
export const StreamEventSchema = z
  .discriminatedUnion('event', [
    z
      .object({
        event: z.literal('on_chat_model_stream'),
        data: z.object({ chunk: z.object({ content: z.string() }) }),
      })
      .openapi({ description: 'Token delta from the model.' }),
    z
      .object({
        event: z.literal('on_tool_start'),
        data: z.object({ name: z.string(), input: z.unknown() }),
      })
      .openapi({ description: 'A tool is about to execute.' }),
    z
      .object({
        event: z.literal('on_tool_end'),
        data: z.object({ name: z.string(), output: z.unknown() }),
      })
      .openapi({ description: 'Tool execution finished; `output` is the rendered result.' }),
    z
      .object({ event: z.literal('on_chain_end'), data: z.unknown() })
      .openapi({ description: 'The agent loop completed.' }),
    z.object({ event: z.literal('on_error'), data: z.object({ message: z.string() }) }).openapi({
      description: 'Terminal error emitted by the server before `[DONE]` so clients see the cause.',
    }),
  ])
  .openapi('StreamEvent');
