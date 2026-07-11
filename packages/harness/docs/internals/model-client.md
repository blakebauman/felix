# Model Client

How Felix talks to LLM providers. Source: `src/patterns/model.ts`.

## Open provider registry

Providers are looked up through a registry, not a hardcoded switch — the open registry is one of the three managed-agents seams (see [docs/README.md](../README.md)). Each provider implements `ModelClient` and registers itself at module load:

```ts
// src/patterns/model.ts (bottom)
registerModelProvider('anthropic',  (env, modelId, route, spec) => new AnthropicGatewayClient(env, modelId, route, spec));
registerModelProvider('openai',     (env, modelId, route, spec) => new OpenAIGatewayClient(env, modelId, route, spec));
registerModelProvider('workers-ai', (env, modelId, route, spec) => new WorkersAiClient(env, modelId, route, spec));
```

`buildModel(env, spec)` resolves the logical id through `MODEL_ROUTES`, then calls `getModelProvider(route.provider)` ([src/patterns/model-registry.ts](../../src/patterns/model-registry.ts)) to look up the factory. Unknown provider names produce an explicit error listing the registered set. Adding a new provider — say, a Vertex AI gateway — is one `registerModelProvider('vertex', ...)` line in `apps/api/src/composition.ts` (or a sibling module imported before the first agent build); `MODEL_ROUTES` then dispatches `provider: 'vertex'` to it with no edits to `model.ts` or `builder.ts`.

`ModelRoute.provider` is typed as `string` (not a literal union) so registry keys aren't constrained by the type system.

## ModelClient surface

`buildModel(env, modelSpec)` returns a provider-specific client implementing this surface:

```ts
interface ModelClient {
  chat(messages, tools, opts?): Promise<ModelChatResult>;
  // text deltas yield; the final ModelChatResult (with any tool_calls
  // and usage) is the generator's RETURN value — captured by the loop
  // via `await stream.next()` once `done === true`. Eliminates the
  // second non-stream call earlier versions made.
  streamChat(messages, tools, opts?): AsyncGenerator<string, ModelChatResult>;
  // Free pre-flight token projection. Anthropic implements via
  // /v1/messages/count_tokens; OpenAI / Workers AI omit it — callers
  // treat that as "skip preflight".
  countTokens?(messages, tools, opts?): Promise<number>;
}
```

`ModelChatOptions` carries `temperature`, `maxTokens`, and an `AbortSignal` (`signal`) that the react/router/parallel patterns wire from `LimitState.abortController.signal` so a wall-clock breach cancels the in-flight gateway fetch.

| Provider | Transport |
|---|---|
| `anthropic` | AI Gateway → `${base}/${slug}/anthropic/v1/messages` |
| `openai`    | AI Gateway → `${base}/${slug}/openai/chat/completions` |
| `workers-ai`| Native `env.AI.run(model, payload)` — no AI Gateway round-trip |

The AI Gateway base is fixed (`https://gateway.ai.cloudflare.com/v1/${AI_GATEWAY_ACCOUNT_ID}`); the `AI_GATEWAY_SLUG` var picks the per-env gateway.

## MODEL_ROUTES resolution

`parseModelRoutes(env)` in `src/env.ts` parses the `MODEL_ROUTES` env JSON. When the var is unset **or** fails to parse, it falls back to the baked-in `DEFAULT_MODEL_ROUTES` map (`src/env.ts`) — `claude-sonnet-4`, `claude-opus-4`, `claude-haiku-4`, `llama-3-fast`, `llama-3-pro` — never to an empty map, so a deployment without the override still resolves the bundled manifests' logical ids.

The map is `Record<logicalId, { provider, model }>`. Manifest authors write the logical id (`spec.model.id`); ops controls the physical mapping at deploy time. This decoupling means a manifest doesn't change when the prod model behind `claude-sonnet-4` is bumped to a newer snapshot.

The fallback when `spec.model.id` is empty is `env.DEFAULT_MODEL_ID`.

## Anthropic via AI Gateway

URL: `${AI_GATEWAY_BASE}/${AI_GATEWAY_SLUG}/anthropic/v1/messages`. The `count_tokens` companion lives at `…/anthropic/v1/messages/count_tokens` and is used by `checkPreflightTokenBudget` (see [governance.md](governance.md)).

Headers:
- `x-api-key: ${env.ANTHROPIC_API_KEY}`
- `anthropic-version: 2023-06-01`
- `content-type: application/json`
- `cf-aig-authorization: Bearer ${env.CF_AIG_TOKEN}` — only when `CF_AIG_TOKEN` is set. Lets the gateway require Authenticated Gateway tokens so a leaked provider key alone can't be replayed against it.

### Request body

- System messages are concatenated into a single `system` string (Anthropic doesn't accept role: system in the messages array).
- Non-system messages are mapped:
  - `role: 'tool'` → `{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }`
  - `role: 'assistant'` + `tool_calls` or `thinking` → `{ role: 'assistant', content: [...thinking blocks, text (if any), ...tool_uses] }`. Thinking blocks (both regular `thinking` with `signature` and `redacted_thinking` with `data`) are echoed verbatim on every assistant turn that produced them — Anthropic verifies the block signatures on any continuation, so reasoning continuity breaks if they're dropped.
  - Plain user/assistant — passthrough.
- Tools → `{ name, description, input_schema }`. `input_schema` comes from `getToolInputSchema(tool)` in `src/patterns/zod-to-json-schema.ts`: returns the tool's `rawInputSchema` if set (remote MCP tools that arrived with a real JSON Schema), otherwise compiles the local Zod `args` via `z.toJSONSchema(schema, { target: 'draft-7' })`.

### Prompt caching (`cache: true`)

When `manifest.spec.model.cache` is true, the body is decorated with up to three `cache_control: { type: 'ephemeral' }` breakpoints — system prompt, last tool definition, and the tail of the last conversation message. `tagLastBlockEphemeral` is the helper that walks the tail content array; **`thinking` / `redacted_thinking` blocks are skipped** because Anthropic rejects `cache_control` on those, so the helper walks backward to find the next cacheable block. Subsequent turns read the prefix from Anthropic's prompt cache (~10% input cost, lower TTFT).

### Extended thinking (`thinking_budget`)

When `manifest.spec.model.thinking_budget` is set (≥ 1024), the request body includes `thinking: { type: 'enabled', budget_tokens: N }`; `temperature` is forced to `1` (Anthropic requirement) and `max_tokens` is raised to at least `budget + 1024` so the model still has room for non-thinking output. The assistant response carries `thinking` content blocks (and `redacted_thinking` blocks with encrypted `data` blobs); these are captured onto `ChatMessage.thinking` and round-tripped on the next continuation. Streaming reassembles thinking blocks from `content_block_start` / `thinking_delta` / `signature_delta` events.

### Response

Content blocks are parsed into a flat `{ message: ChatMessage, stopReason, usage? }`:
- Text blocks contribute to `message.content`.
- `tool_use` blocks become entries in `message.tool_calls`.
- `thinking` / `redacted_thinking` blocks populate `message.thinking`.
- `usage` carries `{ input, output, cache_creation?, cache_read? }` parsed from `data.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`.

stopReason mapping:
- `end_turn` → `'end_turn'`
- `tool_use` → `'tool_use'`
- `max_tokens` → `'max_tokens'`
- `stop_sequence` → `'stop_sequence'`
- anything else → `'unknown'`

### Streaming

`accept: text/event-stream`. The wire format is Anthropic-style SSE with `event: <type>\ndata: {...}\n\n` lines. Reader buffers `pipeThrough(TextDecoderStream())` chunks until it sees `\n\n` so byte-boundary splits in the SSE stream don't corrupt event parsing; a trailing event without a closing `\n\n` is flushed at end-of-stream. The reader yields text deltas (`content_block_delta` / `text_delta`), accumulates tool-use blocks by index (`content_block_start` for the name/id, then `input_json_delta` chunks for the argument JSON), and reassembles thinking blocks from their own deltas. The generator's **return value** is the final `ModelChatResult` carrying `message` (with `tool_calls` + `thinking`), `stopReason`, and `usage` (input/output/cache_creation/cache_read pulled from `message_start.usage` + `message_delta.usage`). No second non-stream call is needed.

## OpenAI via AI Gateway

URL: `${AI_GATEWAY_BASE}/${AI_GATEWAY_SLUG}/openai/chat/completions`.

Headers:
- `authorization: Bearer ${env.OPENAI_API_KEY}`
- `content-type: application/json`
- `cf-aig-authorization: Bearer ${env.CF_AIG_TOKEN}` — only when `CF_AIG_TOKEN` is set (same Authenticated Gateway pattern as the Anthropic path).

### Request body

Messages map (`toOpenAIMessage`):
- `tool` → `{ role: 'tool', tool_call_id, content }`
- `assistant` + `tool_calls` → `{ role: 'assistant', content, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }`
- Others — passthrough.

Tools → `[{ type: 'function', function: { name, description, parameters } }]`.

### Response

`choices[0].message` is parsed back into the internal `ChatMessage`:
- `tool_calls` is mapped; each call's `arguments` string is `JSON.parse`d into `args`.
- stopReason: `tool_calls` → `'tool_use'`, `length` → `'max_tokens'`, else `'end_turn'`.
- `usage` is normalized to the Anthropic shape so `recordUsage` doesn't need provider branches: OpenAI reports `prompt_tokens` as the total including cached portion, so the client computes `input = prompt_tokens - cached_tokens` and surfaces `cache_read = cached_tokens` separately. Without this subtraction, OpenAI cached tokens would double-count against `max_input_tokens`.

### Streaming

OpenAI SSE: `data: {...}\n\n` with terminator `data: [DONE]\n\n`. Reader uses the same `\n\n`-boundary buffer as the Anthropic path. Yields `choices[0].delta.content` chunks; tool_calls are accumulated from `delta.tool_calls[]` (indexed deltas: first delta carries `id` + `function.name`, subsequent deltas append `function.arguments`) and reassembled into the generator's return value alongside `usage`. The request body sets `stream_options.include_usage: true` so the trailing chunk carries the usage block; without it OpenAI streams omit usage entirely. Same input/cache_read subtraction as the non-stream path.

## Workers AI native

Workers AI is called directly through the `env.AI` binding — no AI Gateway hop:

```ts
const out = await env.AI.run(model as keyof AiModels, { messages, temperature, max_tokens, tools? });
```

### Tool-capable models

Tool calling on Workers AI requires a whitelisted model. The current whitelist (`WORKERS_AI_TOOL_CAPABLE` in `src/patterns/model.ts`):

```ts
const WORKERS_AI_TOOL_CAPABLE = new Set([
  '@hf/nousresearch/hermes-2-pro-mistral-7b',
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
]);
```

Calling a non-whitelisted model still gets you a chat completion, but `tool_calls` is always empty so the react loop terminates after the first turn.

### Response normalization

Workers AI returns tool_calls in two shapes depending on model; the client normalizes both:

1. Canonical OpenAI shape: `{ id, function: { name, arguments } }`
2. Flat shape: `{ id, name, arguments }`

Missing ids get `wai_${randomUUID().slice(0, 8)}`. Argument strings are `JSON.parse`d defensively (a parse failure leaves `args = {}`).

### Streaming

`env.AI.run(model, { ...payload, stream: true })` returns a `ReadableStream` over SSE. Each `data: {...}` payload exposes `response` as the text delta; the trailing chunk carries the cumulative `usage` (prompt_tokens / completion_tokens) which becomes the generator's return value. The reader buffers reads until it sees a `\n` and processes complete lines — `TextDecoderStream` chunks split on arbitrary byte boundaries, so a chunk ending mid-`data:` line would otherwise drop content silently. A trailing line not terminated by `\n` is flushed at end-of-stream.

When the agent has tools and the route is on the tool-capable whitelist, `streamChat` falls back to a non-streaming `chat()` (yielding the full text in one chunk) because Workers AI streaming doesn't reliably surface tool_calls.

## Zod → JSON Schema

Tools have Zod schemas (`tool.args`). Anthropic's `input_schema` and OpenAI's `function.parameters` both want JSON Schema. Felix uses Zod v4's native `z.toJSONSchema(schema, { target: 'draft-7' })`, re-exported from `src/patterns/zod-to-json-schema.ts` as `zodToJsonSchema(...)`. Draft-7 keeps the output compatible with Anthropic's tool-calling spec (Anthropic rejects `$schema` / `$defs` from draft-2020-12 unless the rest of the payload is otherwise legal).

`getToolInputSchema(tool)` in the same file is the actual escape hatch the model clients call: it returns `tool.rawInputSchema` when set (used by remote MCP tools that arrived from `tools/list` with a real JSON Schema attached, so the LLM sees the upstream contract verbatim rather than a generic placeholder) and falls back to `zodToJsonSchema(tool.args)` otherwise.

## Model fallbacks and confidence escalation

`spec.model.fallbacks: string[]` and `spec.model.confidence_escalation: { enabled, escalate_to, low_confidence_markers, min_response_chars }` are two orthogonal failure/escalation mechanisms wired in `buildModel(env, spec)` (`src/patterns/model.ts`). Both are eager-built at manifest build time so an unknown logical id or unregistered provider fails the build rather than the first runtime error. Fallbacks are applied first, then confidence escalation wraps the (possibly fallback-chained) client, so an escalated response can itself fall back.

### Fallbacks (`withModelFallbacks`)

Wraps the primary `ModelClient` so each call tries the primary first; on a *provider error* (`isProviderError`: HTTP ≥ 500, 408, or 429, plus network-level failures like `fetch failed` / `ECONNRESET` / `ETIMEDOUT` — `AbortError` is **not** treated as recoverable), it walks the `fallbacks` list of logical-id strings (resolved through `MODEL_ROUTES` the same way as the primary), retrying the same `chat` / `streamChat` call against each in order. The first non-error result wins. `streamChat` wraps the *initial connection* only — once the first chunk lands the wrapper commits to that stream; a mid-token disconnect is surfaced to the loop's own error path, not spliced. On the switch, the wrapper:

- Increments `orchestrator_model_switches { from, to }`.
- Emits a `model_switch` audit event with `status: 'fallback'` and `payload: { from, to, reason: 'provider_error' }`.
- Reuses the same messages + tools — fallback providers see the same conversation, so a thread that started on Anthropic and fails over to OpenAI mid-loop produces a coherent assistant turn.

The wrapper is stateless across calls — every model call independently starts from the primary (no per-thread sticky selection). When the entire chain exhausts without success, the wrapper re-throws the final error so the react loop terminates with a tool-error message instead of looping silently.

### Confidence escalation (`withConfidenceEscalation`)

Active only when both `confidence_escalation.enabled` and `confidence_escalation.escalate_to` are set. After each `chat()` call, the assistant text is scored by `looksLowConfidence(text, markers, minResponseChars)` — low confidence if the text is shorter than `min_response_chars` **or** contains any of the lowercased `low_confidence_markers` substrings (default markers: "i am not sure", "i don't know", "i cannot answer", "unclear", "uncertain", "no information"; default `min_response_chars: 40`). On a low-confidence hit it re-calls the `escalate_to` model with the same messages and returns its response instead. Emits a `model_switch` audit event with `status: 'escalated'` and `payload: { from, to, reason: 'low_confidence' }`, and increments `orchestrator_model_switches { from, to, reason: 'low_confidence' }`. `streamChat` passes straight through without escalating (scoring would require buffering the whole stream).

Use case: route the steady-state of a chat through a cheap model (Haiku, Mistral), escalate only the turns where the cheap model bails out. Fallbacks and escalation can compose — the fallback chain protects against provider outages of either tier.
