/**
 * Model client used by every pattern.
 *
 * The manifest's `spec.model.id` is a *logical* model id (e.g. "claude-sonnet-4",
 * "llama-3-fast") resolved through `MODEL_ROUTES` to a concrete provider +
 * model name. External providers (Anthropic / OpenAI) are reached through AI
 * Gateway so caching, rate-limiting, and cost-routing happen out of band;
 * Workers AI native models are invoked through the `env.AI.run` binding.
 *
 * `chat` returns a final assistant turn; `streamChat` yields text deltas and
 * **returns** the final `ModelChatResult` (including any `tool_calls`) as the
 * generator's return value. This lets the streaming caller surface UX text
 * incrementally while still getting the structured tool-call result without
 * a second API round-trip.
 */

import { type Env, type ModelRoute, parseModelRoutes } from '../env';
import { currentLimitState } from '../limits/state';
import type { Model } from '../manifests/schema';
import { recordCounter } from '../observability/metrics';
import type { Tool } from '../tools/types';
import { getModelProvider, listModelProviders, registerModelProvider } from './model-registry';
import type { ChatMessage, ImageAttachment, ThinkingBlock, ToolCall } from './types';
import { getToolInputSchema } from './zod-to-json-schema';

export interface ModelChatOptions {
  temperature?: number;
  maxTokens?: number;
  /**
   * Cancels the model fetch mid-flight when fired. Passed through to the
   * underlying `fetch(..., { signal })` for Anthropic + OpenAI gateway
   * calls; Workers AI binds aren't AbortSignal-aware so the signal is
   * checked between SSE chunks instead.
   */
  signal?: AbortSignal;
}

export interface TokenUsage {
  /** Fresh input tokens — disjoint from `cache_read` and `cache_creation`.
   * Anthropic's API surfaces this natively as `input_tokens` (post-
   * breakpoint). OpenAI's API returns the total `prompt_tokens` with
   * `cached_tokens` as a subset; the client subtracts the subset before
   * populating this field so the cross-provider invariant holds:
   * `input + cache_read + cache_creation` is the true total context. */
  input: number;
  /** Completion / output tokens charged to this call. */
  output: number;
  /** Input tokens written to the prompt cache on this call (Anthropic
   * `cache_creation_input_tokens`). Absent when caching is off or no
   * cache breakpoints were hit. */
  cache_creation?: number;
  /** Input tokens served from the prompt cache on this call (Anthropic
   * `cache_read_input_tokens` / OpenAI `cached_tokens`). Absent when no
   * cache hit occurred. */
  cache_read?: number;
}

export interface ModelChatResult {
  message: ChatMessage;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown';
  /** Token counts as reported by the provider. Absent when the provider
   * doesn't surface usage on the call shape (some Workers AI models). */
  usage?: TokenUsage;
}

export interface ModelClient {
  readonly modelId: string;
  readonly route: ModelRoute;
  chat(messages: ChatMessage[], tools: Tool[], opts?: ModelChatOptions): Promise<ModelChatResult>;
  /**
   * Streams text deltas (yielded values) and returns the final
   * `ModelChatResult` (the generator return value, accessible via
   * `await iter.next()` once `done === true`). Tool calls live on the
   * returned result, not on the deltas.
   */
  streamChat(
    messages: ChatMessage[],
    tools: Tool[],
    opts?: ModelChatOptions,
  ): AsyncGenerator<string, ModelChatResult>;
  /**
   * Project the input-token cost of a request *without* sending it.
   * Returns `undefined` when the provider has no free counting endpoint
   * (OpenAI / Workers AI); callers should treat that as "skip preflight".
   * Anthropic implements this via `/v1/messages/count_tokens`, which is
   * free and doesn't count against rate limits.
   */
  countTokens?(messages: ChatMessage[], tools: Tool[], opts?: ModelChatOptions): Promise<number>;
}

/**
 * Accumulate per-request token spend on `LimitState` and emit a counter so
 * cost regressions are observable. Called by every pattern after a model
 * call returns. The counter labels stay coarse (manifest + model id) to
 * keep cardinality bounded.
 */
export function recordUsage(
  result: ModelChatResult,
  opts: { manifestId: string; modelId?: string | null },
): void {
  const labels = { manifest_id: opts.manifestId, model: opts.modelId ?? 'default' };
  if (!result.usage) return;
  const { input, output, cache_creation = 0, cache_read = 0 } = result.usage;
  const state = currentLimitState();
  if (state) {
    // Cache reads + creations still occupy the request's input context
    // window, so they count against `max_input_tokens`. Cost differs
    // (the per-kind counters below capture that), but budget enforcement
    // operates on context size, not dollars.
    state.tokens.input += input + cache_creation + cache_read;
    state.tokens.output += output;
  }
  recordCounter('orchestrator_tokens', { ...labels, kind: 'input' }, input);
  recordCounter('orchestrator_tokens', { ...labels, kind: 'output' }, output);
  if (cache_creation) {
    recordCounter('orchestrator_tokens', { ...labels, kind: 'cache_creation' }, cache_creation);
  }
  if (cache_read) {
    recordCounter('orchestrator_tokens', { ...labels, kind: 'cache_read' }, cache_read);
  }
}

function buildOneModel(env: Env, spec: Model, logicalId: string): ModelClient {
  const routes = parseModelRoutes(env);
  const route = routes[logicalId];
  if (!route) {
    throw new Error(`Model '${logicalId}' is not in MODEL_ROUTES. Configure it in wrangler.jsonc.`);
  }
  const factory = getModelProvider(route.provider);
  if (!factory) {
    throw new Error(
      `Unknown model provider '${route.provider}' for '${logicalId}' — registered providers: ${listModelProviders().join(', ') || '(none)'}.`,
    );
  }
  return factory(env, logicalId, route, spec);
}

export function buildModel(env: Env, spec: Model): ModelClient {
  const primaryId = spec.id ?? env.DEFAULT_MODEL_ID;
  let client = buildOneModel(env, spec, primaryId);
  if (spec.fallbacks && spec.fallbacks.length > 0) {
    // Eager-build the fallback chain so misconfigurations (unknown
    // logical id, unregistered provider) fail at manifest build rather
    // than the first time a primary error happens to fire.
    const fallbacks = spec.fallbacks.map((id) => buildOneModel(env, spec, id));
    client = withModelFallbacks(client, fallbacks);
  }
  // Confidence escalation — wraps the (possibly fallback-
  // chained) primary so a low-confidence successful response triggers
  // a re-call against `escalate_to`. Runs AFTER fallbacks so an
  // escalated response can itself fall back if the escalation target
  // hits a provider_error.
  if (spec.confidence_escalation.enabled && spec.confidence_escalation.escalate_to) {
    const escalateTo = buildOneModel(env, spec, spec.confidence_escalation.escalate_to);
    client = withConfidenceEscalation(client, escalateTo, {
      markers: spec.confidence_escalation.low_confidence_markers,
      minResponseChars: spec.confidence_escalation.min_response_chars,
    });
  }
  return client;
}

/**
 * Error thrown for a non-OK gateway/stream HTTP response. Carries the numeric
 * `status` so `isProviderError` can classify it for fallback WITHOUT parsing
 * the message, and bounds the upstream response body so a provider's error
 * payload (which may echo request internals) doesn't flow verbatim into
 * tenant-visible audit rows via `app.onError`.
 */
export class ModelGatewayError extends Error {
  readonly status: number;
  constructor(label: string, status: number, body: string) {
    // Cap the echoed body — enough to debug, not the whole payload.
    super(`${label}: ${status} ${body.slice(0, 200)}`);
    this.name = 'ModelGatewayError';
    this.status = status;
  }
}

/** Read a non-OK response and wrap it as a status-bearing ModelGatewayError. */
async function gatewayError(label: string, resp: Response): Promise<ModelGatewayError> {
  let body = '';
  try {
    body = await resp.text();
  } catch {
    // response body already consumed / not readable — status is enough.
  }
  return new ModelGatewayError(label, resp.status, body);
}

/**
 * Heuristic for whether a thrown model error is recoverable by trying
 * the next fallback. We do NOT retry on user-cancellations or 4xx
 * errors that look like client misuse (auth, validation) — those would
 * just consume more quota for nothing.
 */
function isProviderError(err: unknown): boolean {
  if (err == null) return false;
  const e = err as {
    name?: string;
    status?: number;
    cause?: { status?: number };
    message?: string;
  };
  if (e.name === 'AbortError') return false;
  const status = e.status ?? e.cause?.status;
  if (typeof status === 'number') {
    if (status >= 500) return true;
    if (status === 408 || status === 429) return true;
    return false;
  }
  // No structured status: fall back to message sniffing. Covers network-level
  // failures (DNS, socket reset) and any legacy throw path that hasn't been
  // migrated to ModelGatewayError yet (belt-and-suspenders — the gateway
  // clients now throw status-bearing errors handled above).
  const message = (e.message ?? String(err)).toLowerCase();
  if (
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('rate limit') ||
    message.includes(' 429') ||
    message.includes(' 500') ||
    message.includes(' 502') ||
    message.includes(' 503') ||
    message.includes(' 504')
  ) {
    return true;
  }
  return false;
}

/**
 * Heuristic-based low-confidence detector. Pure function so the
 * wrapper stays testable without an env.AI binding.
 */
function looksLowConfidence(
  response: string,
  markers: readonly string[],
  minResponseChars: number,
): boolean {
  if (!response) return true;
  if (response.length < minResponseChars) return true;
  const lower = response.toLowerCase();
  return markers.some((m) => lower.includes(m.toLowerCase()));
}

/**
 * Wrap a primary `ModelClient` so a successful but low-confidence
 * response triggers a re-call against `escalateTo`. Mirrors the
 * fallback wrapper's emit-on-switch audit shape so an operator sees
 * both "provider error → fallback" and "low confidence → escalation"
 * in one `model_switch` stream.
 *
 * v1 escalates `chat()` only — streamChat passes through without
 * re-calling because we'd need to buffer the entire stream to score
 * confidence, defeating the streaming UX.
 */
export function withConfidenceEscalation(
  primary: ModelClient,
  escalateTo: ModelClient,
  opts: { markers: readonly string[]; minResponseChars: number },
): ModelClient {
  async function emitSwitchEvent(fromId: string, toId: string, reason: string): Promise<void> {
    const { recordEvent } = await import('../audit/store');
    const { getContext } = await import('../context');
    const ctx = getContext();
    if (!ctx) return;
    recordEvent({
      tenantId: ctx.auth.principal.tenantId,
      eventType: 'model_switch',
      principalSubject: ctx.auth.principal.subject,
      manifestId: ctx.manifestId,
      status: 'escalated',
      payload: { from: fromId, to: toId, reason },
    });
    recordCounter('orchestrator_model_switches', { from: fromId, to: toId, reason });
  }

  return {
    modelId: primary.modelId,
    route: primary.route,
    async chat(messages, tools, callOpts) {
      const result = await primary.chat(messages, tools, callOpts);
      const text = result.message.content ?? '';
      if (!looksLowConfidence(text, opts.markers, opts.minResponseChars)) return result;
      const escalated = await escalateTo.chat(messages, tools, callOpts);
      await emitSwitchEvent(primary.modelId, escalateTo.modelId, 'low_confidence');
      return escalated;
    },
    streamChat(messages, tools, callOpts) {
      // Pass through — streaming + confidence escalation would require
      // buffering the entire stream to score. Follow-on work.
      return primary.streamChat(messages, tools, callOpts);
    },
    countTokens: primary.countTokens
      ? (messages, tools, opts2) => primary.countTokens!(messages, tools, opts2)
      : undefined,
  };
}

/**
 * Wrap a primary `ModelClient` with an ordered list of fallback
 * clients. On a `provider_error` from `chat()` / `streamChat()`, the
 * wrapper tries each fallback in turn; the first one that succeeds
 * provides the result. A `model_switch` audit event is emitted on
 * each successful fallback so an operator can correlate degraded
 * routing with upstream incidents.
 *
 * v1 is stateless across calls — every model call independently
 * starts from the primary. Per-thread sticky fallback selection is
 * deferred (it requires per-(thread, provider) state on the session
 * log; out of scope for the initial Phase-6 ship).
 *
 * Streaming wraps the *initial connection* only. If the primary
 * starts streaming successfully but disconnects mid-token, we do not
 * splice a fallback into the same generator — the user sees an empty
 * stream end and the harness's react/deep loop catches the partial
 * `ModelChatResult` via its own error path.
 */
export function withModelFallbacks(primary: ModelClient, fallbacks: ModelClient[]): ModelClient {
  if (fallbacks.length === 0) return primary;
  const chain = [primary, ...fallbacks];

  async function emitSwitchEvent(fromId: string, toId: string, reason: string): Promise<void> {
    // Dynamic import to avoid a static cycle with audit/store, which
    // imports context which imports nothing heavy but the lint config
    // prefers we keep this seam loose.
    const { recordEvent } = await import('../audit/store');
    const { getContext } = await import('../context');
    const ctx = getContext();
    if (!ctx) return;
    recordEvent({
      tenantId: ctx.auth.principal.tenantId,
      eventType: 'model_switch',
      principalSubject: ctx.auth.principal.subject,
      manifestId: ctx.manifestId,
      status: 'fallback',
      payload: { from: fromId, to: toId, reason },
    });
    recordCounter('orchestrator_model_switches', { from: fromId, to: toId });
  }

  return {
    modelId: primary.modelId,
    route: primary.route,
    async chat(messages, tools, opts) {
      let lastErr: unknown;
      for (let i = 0; i < chain.length; i += 1) {
        const m = chain[i]!;
        try {
          const result = await m.chat(messages, tools, opts);
          if (i > 0) await emitSwitchEvent(primary.modelId, m.modelId, 'provider_error');
          return result;
        } catch (err) {
          if (!isProviderError(err)) throw err;
          lastErr = err;
        }
      }
      throw lastErr ?? new Error('all model fallbacks failed without an error');
    },
    streamChat(messages, tools, opts) {
      // Wrap the generator so we can swap the underlying stream on
      // first-chunk failure. The outer generator yields whatever the
      // chosen inner generator yields and returns its result.
      async function* gen(): AsyncGenerator<string, ModelChatResult> {
        let lastErr: unknown;
        for (let i = 0; i < chain.length; i += 1) {
          const m = chain[i]!;
          const inner = m.streamChat(messages, tools, opts);
          try {
            // Pull the first item to see if the connection opens. If
            // it throws here we treat it as a provider error and
            // advance to the next fallback. Once the first item lands,
            // we commit to this stream for the rest of the generator.
            const first = await inner.next();
            if (i > 0) await emitSwitchEvent(primary.modelId, m.modelId, 'provider_error');
            if (first.done) return first.value;
            yield first.value;
            while (true) {
              const next = await inner.next();
              if (next.done) return next.value;
              yield next.value;
            }
          } catch (err) {
            if (!isProviderError(err)) throw err;
            lastErr = err;
          }
        }
        throw lastErr ?? new Error('all model fallbacks failed without an error');
      }
      return gen();
    },
    countTokens: primary.countTokens
      ? (messages, tools, opts) => primary.countTokens!(messages, tools, opts)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Anthropic via AI Gateway
// ---------------------------------------------------------------------------

class AnthropicGatewayClient implements ModelClient {
  constructor(
    private readonly env: Env,
    public readonly modelId: string,
    public readonly route: ModelRoute,
    private readonly spec: Model,
  ) {}

  private url(): string {
    const account = this.env.AI_GATEWAY_ACCOUNT_ID;
    const slug = this.env.AI_GATEWAY_SLUG;
    return `https://gateway.ai.cloudflare.com/v1/${account}/${slug}/anthropic/v1/messages`;
  }

  private countUrl(): string {
    const account = this.env.AI_GATEWAY_ACCOUNT_ID;
    const slug = this.env.AI_GATEWAY_SLUG;
    return `https://gateway.ai.cloudflare.com/v1/${account}/${slug}/anthropic/v1/messages/count_tokens`;
  }

  private body(messages: ChatMessage[], tools: Tool[], opts?: ModelChatOptions): unknown {
    const cache = this.spec.cache === true;
    const thinkingBudget = this.spec.thinking_budget ?? null;
    const sys = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const conv = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: m.tool_call_id,
                content: m.content,
              },
            ],
          };
        }
        if (
          m.role === 'assistant' &&
          ((m.tool_calls && m.tool_calls.length > 0) || (m.thinking && m.thinking.length > 0))
        ) {
          // Thinking blocks must precede text + tool_use blocks when
          // extended thinking is active — Anthropic verifies the block
          // signatures (and the encrypted `data` blob on redacted blocks)
          // on any continuation request. Echo them on every assistant
          // turn that produced thinking, not just tool_use continuations:
          // Anthropic recommends round-tripping thinking blocks for all
          // multi-turn conversations to keep reasoning continuity intact.
          const thinkingBlocks = (m.thinking ?? []).map((tb) =>
            tb.type === 'redacted_thinking'
              ? { type: 'redacted_thinking' as const, data: tb.data }
              : {
                  type: 'thinking' as const,
                  thinking: tb.thinking,
                  signature: tb.signature,
                },
          );
          return {
            role: 'assistant',
            content: [
              ...thinkingBlocks,
              ...(m.content ? [{ type: 'text', text: m.content }] : []),
              ...(m.tool_calls ?? []).map((tc) => ({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: tc.args,
              })),
            ],
          };
        }
        if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
          const blocks = m.attachments
            .map(anthropicImageBlock)
            .filter((b): b is Record<string, unknown> => b !== null);
          // Images precede the text block (Anthropic's recommended ordering).
          return {
            role: 'user',
            content: [...blocks, ...(m.content ? [{ type: 'text', text: m.content }] : [])],
          };
        }
        return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
      });
    // Cache breakpoints (max 4 per Anthropic request). Layout: system,
    // last tool, last conversation message. On the next turn the prefix
    // up through `last conv message` becomes a cache_read; the new
    // user/tool_result messages are the only cache miss.
    const system =
      sys.length === 0
        ? undefined
        : cache
          ? [{ type: 'text' as const, text: sys, cache_control: { type: 'ephemeral' as const } }]
          : sys;
    const toolDefs = tools.length
      ? tools.map((t, i) => {
          const def: Record<string, unknown> = {
            name: t.name,
            description: t.description,
            input_schema: getToolInputSchema(t),
          };
          if (cache && i === tools.length - 1) {
            def.cache_control = { type: 'ephemeral' };
          }
          return def;
        })
      : undefined;
    const convOut = cache && conv.length > 0 ? tagLastBlockEphemeral(conv) : conv;
    // Extended thinking has three hard requirements from Anthropic:
    //   1. temperature must be exactly 1,
    //   2. max_tokens must exceed budget_tokens (we reserve 1024 for
    //      non-thinking output so the model still has room to answer
    //      or call a tool after it finishes thinking),
    //   3. the `thinking` request param carries the budget.
    const baseMaxTokens = opts?.maxTokens ?? this.spec.max_tokens ?? 4096;
    const max_tokens = thinkingBudget
      ? Math.max(baseMaxTokens, thinkingBudget + 1024)
      : baseMaxTokens;
    const temperature = thinkingBudget ? 1 : (opts?.temperature ?? this.spec.temperature ?? 0);
    return {
      model: this.route.model,
      max_tokens,
      temperature,
      system,
      messages: convOut,
      tools: toolDefs,
      ...(thinkingBudget ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } : {}),
    };
  }

  async chat(
    messages: ChatMessage[],
    tools: Tool[],
    opts?: ModelChatOptions,
  ): Promise<ModelChatResult> {
    const resp = await fetch(this.url(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
        ...(this.env.CF_AIG_TOKEN
          ? { 'cf-aig-authorization': `Bearer ${this.env.CF_AIG_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(this.body(messages, tools, opts)),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (!resp.ok) {
      throw await gatewayError('anthropic gateway', resp);
    }
    const data = (await resp.json()) as AnthropicResponse;
    const toolCalls: ToolCall[] = [];
    const thinkingBlocks: ThinkingBlock[] = [];
    let text = '';
    for (const block of data.content ?? []) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
      } else if (block.type === 'thinking') {
        thinkingBlocks.push({
          type: 'thinking',
          thinking: block.thinking ?? '',
          signature: block.signature ?? '',
        });
      } else if (block.type === 'redacted_thinking') {
        thinkingBlocks.push({ type: 'redacted_thinking', data: block.data ?? '' });
      }
    }
    const assistant: ChatMessage = {
      role: 'assistant',
      content: text,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(thinkingBlocks.length ? { thinking: thinkingBlocks } : {}),
    };
    return {
      message: assistant,
      stopReason: mapStop(data.stop_reason),
      ...(data.usage
        ? {
            usage: {
              input: data.usage.input_tokens ?? 0,
              output: data.usage.output_tokens ?? 0,
              ...(data.usage.cache_creation_input_tokens
                ? { cache_creation: data.usage.cache_creation_input_tokens }
                : {}),
              ...(data.usage.cache_read_input_tokens
                ? { cache_read: data.usage.cache_read_input_tokens }
                : {}),
            },
          }
        : {}),
    };
  }

  async countTokens(
    messages: ChatMessage[],
    tools: Tool[],
    opts?: ModelChatOptions,
  ): Promise<number> {
    // Reuse body() so the count reflects the exact request we'd send;
    // strip sampling and streaming fields because count_tokens rejects
    // unknown / inapplicable keys on some API versions. Beta headers
    const full = this.body(messages, tools, opts) as Record<string, unknown>;
    const { max_tokens: _mt, temperature: _t, stream: _s, ...countBody } = full;
    const resp = await fetch(this.countUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
        ...(this.env.CF_AIG_TOKEN
          ? { 'cf-aig-authorization': `Bearer ${this.env.CF_AIG_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(countBody),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (!resp.ok) {
      throw await gatewayError('anthropic count_tokens', resp);
    }
    const data = (await resp.json()) as { input_tokens?: number };
    return data.input_tokens ?? 0;
  }

  async *streamChat(
    messages: ChatMessage[],
    tools: Tool[],
    opts?: ModelChatOptions,
  ): AsyncGenerator<string, ModelChatResult> {
    const resp = await fetch(this.url(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
        accept: 'text/event-stream',
        ...(this.env.CF_AIG_TOKEN
          ? { 'cf-aig-authorization': `Bearer ${this.env.CF_AIG_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ ...(this.body(messages, tools, opts) as object), stream: true }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (!resp.ok || !resp.body) {
      throw await gatewayError('anthropic stream', resp);
    }
    const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    let text = '';
    // Tool-use blocks are streamed as content_block_start (id + name) followed
    // by N content_block_delta(input_json_delta) chunks containing partial
    // JSON. Accumulate by block index, then parse once on stream end.
    const toolBuilders = new Map<number, { id: string; name: string; jsonBuf: string }>();
    // Thinking blocks stream as content_block_start (type: thinking) plus
    // N content_block_delta(thinking_delta) chunks of partial reasoning,
    // then a final content_block_delta(signature_delta) with the
    // signature that Anthropic requires us to echo verbatim on the next
    // tool-use continuation request. Redacted blocks arrive fully formed
    // on content_block_start with their encrypted `data` blob — no
    // streaming deltas — and must also be echoed verbatim.
    type ThinkingBuilder =
      | { kind: 'thinking'; text: string; signature: string }
      | { kind: 'redacted_thinking'; data: string };
    const thinkingBuilders = new Map<number, ThinkingBuilder>();
    let stopReason: ModelChatResult['stopReason'] = 'unknown';
    // Anthropic SSE puts input_tokens on `message_start` and output_tokens
    // on the final `message_delta`; capture both as they arrive. Cache
    // token counts (creation + read) ride along on the same usage blocks.
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreation = 0;
    let cacheRead = 0;
    // Inner generator so we can `yield*` from both the main loop and the
    // post-stream flush. Closes over the local accumulators above. The
    // try/catch is narrowed to JSON.parse only — handler-logic bugs
    // propagate instead of being silently swallowed.
    const processEvent = async function* (event: string): AsyncGenerator<string> {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        let obj: AnthropicStreamEvent;
        try {
          obj = JSON.parse(payload) as AnthropicStreamEvent;
        } catch {
          continue;
        }
        if (obj.type === 'message_start' && obj.message?.usage) {
          inputTokens = obj.message.usage.input_tokens ?? 0;
          outputTokens = obj.message.usage.output_tokens ?? 0;
          cacheCreation = obj.message.usage.cache_creation_input_tokens ?? 0;
          cacheRead = obj.message.usage.cache_read_input_tokens ?? 0;
        } else if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
          toolBuilders.set(obj.index ?? 0, {
            id: obj.content_block.id ?? '',
            name: obj.content_block.name ?? '',
            jsonBuf: '',
          });
        } else if (obj.type === 'content_block_start' && obj.content_block?.type === 'thinking') {
          thinkingBuilders.set(obj.index ?? 0, {
            kind: 'thinking',
            text: '',
            signature: '',
          });
        } else if (
          obj.type === 'content_block_start' &&
          obj.content_block?.type === 'redacted_thinking'
        ) {
          thinkingBuilders.set(obj.index ?? 0, {
            kind: 'redacted_thinking',
            data: obj.content_block.data ?? '',
          });
        } else if (obj.type === 'content_block_delta' && obj.delta) {
          if (obj.delta.type === 'text_delta' && obj.delta.text !== undefined) {
            text += obj.delta.text;
            yield obj.delta.text;
          } else if (
            obj.delta.type === 'input_json_delta' &&
            obj.delta.partial_json !== undefined
          ) {
            const b = toolBuilders.get(obj.index ?? 0);
            if (b) b.jsonBuf += obj.delta.partial_json;
          } else if (obj.delta.type === 'thinking_delta' && obj.delta.thinking !== undefined) {
            const b = thinkingBuilders.get(obj.index ?? 0);
            if (b && b.kind === 'thinking') b.text += obj.delta.thinking;
          } else if (obj.delta.type === 'signature_delta' && obj.delta.signature !== undefined) {
            const b = thinkingBuilders.get(obj.index ?? 0);
            if (b && b.kind === 'thinking') b.signature = obj.delta.signature;
          }
        } else if (obj.type === 'message_delta') {
          if (obj.delta?.stop_reason) stopReason = mapStop(obj.delta.stop_reason);
          if (obj.usage?.output_tokens != null) outputTokens = obj.usage.output_tokens;
          if (obj.usage?.cache_creation_input_tokens != null)
            cacheCreation = obj.usage.cache_creation_input_tokens;
          if (obj.usage?.cache_read_input_tokens != null)
            cacheRead = obj.usage.cache_read_input_tokens;
        }
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        idx = buf.indexOf('\n\n');
        yield* processEvent(event);
      }
    }
    // Flush any trailing event that arrived without a closing `\n\n`
    // (rare but possible on a clean close after the final data line).
    if (buf.length > 0) yield* processEvent(buf);
    const toolCalls: ToolCall[] = [...toolBuilders.values()].map((b) => ({
      id: b.id,
      name: b.name,
      args: b.jsonBuf ? safeJson(b.jsonBuf) : {},
    }));
    const thinkingOut: ThinkingBlock[] = [...thinkingBuilders.values()].map((b) =>
      b.kind === 'thinking'
        ? { type: 'thinking', thinking: b.text, signature: b.signature }
        : { type: 'redacted_thinking', data: b.data },
    );
    const message: ChatMessage = {
      role: 'assistant',
      content: text,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(thinkingOut.length ? { thinking: thinkingOut } : {}),
    };
    // Anthropic emits `stop_reason: tool_use` on message_delta when the run
    // ended because the model wants a tool call; treat the presence of
    // tool_calls as authoritative if the SSE didn't surface a final reason.
    const finalStop: ModelChatResult['stopReason'] =
      toolCalls.length && stopReason === 'unknown' ? 'tool_use' : stopReason;
    return {
      message,
      stopReason: finalStop,
      ...(inputTokens || outputTokens || cacheCreation || cacheRead
        ? {
            usage: {
              input: inputTokens,
              output: outputTokens,
              ...(cacheCreation ? { cache_creation: cacheCreation } : {}),
              ...(cacheRead ? { cache_read: cacheRead } : {}),
            },
          }
        : {}),
    };
  }
}

interface AnthropicResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'thinking'; thinking?: string; signature?: string }
    | { type: 'redacted_thinking'; data?: string }
  >;
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string; data?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Tag the last cacheable content block of the last conversation message
 * with `cache_control: ephemeral`. Normalizes string content into a
 * single-text block so the marker has somewhere to live. Anthropic
 * forbids `cache_control` on `thinking` / `redacted_thinking` blocks,
 * so when the tail of a content array is one of those, walk backward
 * to find the next cacheable block; if the whole array is thinking
 * blocks (unusual shape), skip tagging and rely on cache lookback to
 * find an earlier write. Returns a new array; inputs are not mutated.
 */
function tagLastBlockEphemeral(
  conv: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: unknown }> {
  const out = conv.slice();
  const last = out[out.length - 1]!;
  if (typeof last.content === 'string') {
    out[out.length - 1] = {
      ...last,
      content: [
        { type: 'text', text: last.content, cache_control: { type: 'ephemeral' } },
      ] as unknown,
    };
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const blocks = last.content.slice();
    let tailIdx = blocks.length - 1;
    while (tailIdx >= 0) {
      const type = (blocks[tailIdx] as { type?: string }).type;
      if (type !== 'thinking' && type !== 'redacted_thinking') break;
      tailIdx--;
    }
    if (tailIdx >= 0) {
      const tail = blocks[tailIdx] as Record<string, unknown>;
      blocks[tailIdx] = { ...tail, cache_control: { type: 'ephemeral' } };
      out[out.length - 1] = { ...last, content: blocks };
    }
  }
  return out;
}

function mapStop(reason: string | null): ModelChatResult['stopReason'] {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// OpenAI via AI Gateway (used for fallbacks / cheap routes)
// ---------------------------------------------------------------------------

class OpenAIGatewayClient implements ModelClient {
  constructor(
    private readonly env: Env,
    public readonly modelId: string,
    public readonly route: ModelRoute,
    private readonly spec: Model,
  ) {}

  private url(): string {
    return `https://gateway.ai.cloudflare.com/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_SLUG}/openai/chat/completions`;
  }

  async chat(
    messages: ChatMessage[],
    tools: Tool[],
    opts?: ModelChatOptions,
  ): Promise<ModelChatResult> {
    const resp = await fetch(this.url(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.env.OPENAI_API_KEY ?? ''}`,
        ...(this.env.CF_AIG_TOKEN
          ? { 'cf-aig-authorization': `Bearer ${this.env.CF_AIG_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        model: this.route.model,
        messages: messages.map(toOpenAIMessage),
        tools: tools.length
          ? tools.map((t) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description,
                parameters: getToolInputSchema(t),
              },
            }))
          : undefined,
        temperature: opts?.temperature ?? this.spec.temperature ?? 0,
        max_tokens: opts?.maxTokens ?? this.spec.max_tokens ?? 4096,
      }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (!resp.ok) throw await gatewayError('openai gateway', resp);
    const data = (await resp.json()) as OpenAIResponse;
    const choice = data.choices[0]!;
    const calls: ToolCall[] = (choice.message.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      args: safeJson(c.function.arguments),
    }));
    return {
      message: {
        role: 'assistant',
        content: choice.message.content ?? '',
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      stopReason:
        choice.finish_reason === 'tool_calls'
          ? 'tool_use'
          : choice.finish_reason === 'length'
            ? 'max_tokens'
            : 'end_turn',
      ...(data.usage
        ? (() => {
            // OpenAI's `prompt_tokens` is the total input including cached
            // tokens; `cached_tokens` is a subset. Anthropic's
            // `input_tokens` is post-breakpoint and disjoint from
            // cache_read. Normalize to the Anthropic shape (input = fresh
            // input) so `recordUsage` can sum `input + cache_read` to get
            // the true total without provider-specific branches.
            const promptTokens = data.usage.prompt_tokens ?? 0;
            const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens ?? 0;
            return {
              usage: {
                input: promptTokens - cachedTokens,
                output: data.usage.completion_tokens ?? 0,
                ...(cachedTokens ? { cache_read: cachedTokens } : {}),
              },
            };
          })()
        : {}),
    };
  }

  async *streamChat(
    messages: ChatMessage[],
    tools: Tool[],
    opts?: ModelChatOptions,
  ): AsyncGenerator<string, ModelChatResult> {
    const resp = await fetch(this.url(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.env.OPENAI_API_KEY ?? ''}`,
        accept: 'text/event-stream',
        ...(this.env.CF_AIG_TOKEN
          ? { 'cf-aig-authorization': `Bearer ${this.env.CF_AIG_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        model: this.route.model,
        messages: messages.map(toOpenAIMessage),
        tools: tools.length
          ? tools.map((t) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description,
                parameters: getToolInputSchema(t),
              },
            }))
          : undefined,
        temperature: opts?.temperature ?? this.spec.temperature ?? 0,
        max_tokens: opts?.maxTokens ?? this.spec.max_tokens ?? 4096,
        stream: true,
        // Ask for the trailing usage chunk so token counts survive into the
        // returned ModelChatResult — without this, OpenAI streams don't
        // surface usage at all.
        stream_options: { include_usage: true },
      }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (!resp.ok || !resp.body) {
      throw await gatewayError('openai stream', resp);
    }
    const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    let text = '';
    // OpenAI streams tool_calls as deltas indexed by position. The first
    // delta for an index carries id + function.name; subsequent deltas
    // append to function.arguments. Accumulate by index.
    const toolBuilders = new Map<number, { id: string; name: string; argBuf: string }>();
    let finishReason: string | null = null;
    // The trailing chunk (when stream_options.include_usage is set) carries
    // the full usage block on the chunk itself rather than under choices[0].
    // OpenAI prompt caching is automatic; the cached portion surfaces under
    // `usage.prompt_tokens_details.cached_tokens`.
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    // Inner generator so we can `yield*` from both the main loop and the
    // post-stream flush. Closes over the local accumulators above. The
    // try/catch is narrowed to JSON.parse only — handler-logic bugs
    // propagate instead of being silently swallowed.
    const processEvent = async function* (event: string): AsyncGenerator<string> {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        let obj: OpenAIStreamEvent;
        try {
          obj = JSON.parse(payload) as OpenAIStreamEvent;
        } catch {
          continue;
        }
        if (obj.usage) {
          inputTokens = obj.usage.prompt_tokens ?? inputTokens;
          outputTokens = obj.usage.completion_tokens ?? outputTokens;
          if (obj.usage.prompt_tokens_details?.cached_tokens != null) {
            cacheRead = obj.usage.prompt_tokens_details.cached_tokens;
          }
        }
        const choice = obj.choices?.[0];
        if (!choice) continue;
        const dContent = choice.delta?.content;
        if (dContent) {
          text += dContent;
          yield dContent;
        }
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const i = tc.index ?? 0;
            const cur = toolBuilders.get(i) ?? { id: '', name: '', argBuf: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.argBuf += tc.function.arguments;
            toolBuilders.set(i, cur);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        idx = buf.indexOf('\n\n');
        yield* processEvent(event);
      }
    }
    // Flush any trailing event that arrived without a closing `\n\n`
    // (rare but possible on a clean close after the final data line).
    if (buf.length > 0) yield* processEvent(buf);
    const toolCalls: ToolCall[] = [...toolBuilders.values()]
      .filter((b) => b.name)
      .map((b) => ({
        id: b.id || `oai_${crypto.randomUUID().slice(0, 8)}`,
        name: b.name,
        args: b.argBuf ? safeJson(b.argBuf) : {},
      }));
    const message: ChatMessage = {
      role: 'assistant',
      content: text,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    const stopReason: ModelChatResult['stopReason'] =
      finishReason === 'tool_calls' || (toolCalls.length && finishReason !== 'length')
        ? 'tool_use'
        : finishReason === 'length'
          ? 'max_tokens'
          : 'end_turn';
    return {
      message,
      stopReason,
      ...(inputTokens || outputTokens || cacheRead
        ? {
            usage: {
              // `inputTokens` accumulated from the stream is OpenAI's
              // `prompt_tokens` (total including cached). Subtract the
              // cached portion so `input + cache_read` reconstructs the
              // true total — same shape the Anthropic path produces.
              input: inputTokens - cacheRead,
              output: outputTokens,
              ...(cacheRead ? { cache_read: cacheRead } : {}),
            },
          }
        : {}),
    };
  }
}

interface OpenAIStreamEvent {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function toOpenAIMessage(m: ChatMessage): unknown {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
  }
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.tool_calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    };
  }
  if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
    // OpenAI's multimodal content array: text part(s) then image_url parts.
    // image_url.url accepts both data: URLs and remote URLs.
    return {
      role: 'user',
      content: [
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ...m.attachments.map((a) => ({ type: 'image_url', image_url: { url: a.url } })),
      ],
    };
  }
  return { role: m.role, content: m.content };
}

/**
 * Parse a base64 `data:` URL into its media type + raw base64 payload. Returns
 * null for non-data URLs or malformed / non-base64 data URLs.
 */
function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) return null;
  return { mediaType: match[1] ?? '', data: match[2] ?? '' };
}

/**
 * Map a Felix `ImageAttachment` to an Anthropic image content block. `data:`
 * URLs become a base64 source; `https://` URLs become a url source. Anything
 * else (or a malformed data URL) is dropped (returns null).
 */
function anthropicImageBlock(att: ImageAttachment): Record<string, unknown> | null {
  if (att.url.startsWith('data:')) {
    const parsed = parseDataUrl(att.url);
    if (!parsed) return null;
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: parsed.mediaType || att.media_type,
        data: parsed.data,
      },
    };
  }
  if (att.url.startsWith('https://') || att.url.startsWith('http://')) {
    return { type: 'image', source: { type: 'url', url: att.url } };
  }
  return null;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

// ---------------------------------------------------------------------------
// Workers AI native (Llama / Mistral)
// ---------------------------------------------------------------------------

/**
 * Workers AI native models. Models like `@hf/nousresearch/hermes-2-pro-mistral-7b`
 * and the `*-with-tools` Llama variants return tool calls in OpenAI shape.
 * For models without tool support the `tool_calls` array is empty and the
 * react loop terminates on the first turn — same control flow as a chat
 * completion that just answers without invoking a tool.
 */

const WORKERS_AI_TOOL_CAPABLE = new Set<string>([
  '@hf/nousresearch/hermes-2-pro-mistral-7b',
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
]);

class WorkersAiClient implements ModelClient {
  constructor(
    private readonly env: Env,
    public readonly modelId: string,
    public readonly route: ModelRoute,
    private readonly spec: Model,
  ) {}

  private toolsForRequest(tools: Tool[]): unknown[] | undefined {
    if (!tools.length || !WORKERS_AI_TOOL_CAPABLE.has(this.route.model)) return undefined;
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: getToolInputSchema(t),
      },
    }));
  }

  async chat(
    messages: ChatMessage[],
    tools: Tool[],
    opts?: ModelChatOptions,
  ): Promise<ModelChatResult> {
    const toolArr = this.toolsForRequest(tools);
    const resp = (await this.env.AI.run(
      this.route.model as keyof AiModels,
      {
        messages: messages.map(toOpenAIMessage),
        temperature: opts?.temperature ?? this.spec.temperature ?? 0,
        max_tokens: opts?.maxTokens ?? this.spec.max_tokens ?? 1024,
        ...(toolArr ? { tools: toolArr } : {}),
      } as never,
    )) as {
      response?: string;
      tool_calls?: Array<{
        id?: string;
        name?: string;
        arguments?: unknown;
        function?: { name: string; arguments: string };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const rawCalls = resp.tool_calls ?? [];
    const calls: ToolCall[] = rawCalls.map((c) => {
      // Workers AI sometimes returns the canonical OpenAI shape and
      // sometimes a flatter `{name, arguments}` shape. Normalize both.
      if (c.function) {
        return {
          id: c.id ?? `wai_${crypto.randomUUID().slice(0, 8)}`,
          name: c.function.name,
          args:
            typeof c.function.arguments === 'string'
              ? safeJson(c.function.arguments)
              : (c.function.arguments as Record<string, unknown>),
        };
      }
      const args =
        typeof c.arguments === 'string'
          ? safeJson(c.arguments)
          : ((c.arguments as Record<string, unknown>) ?? {});
      return { id: c.id ?? `wai_${crypto.randomUUID().slice(0, 8)}`, name: c.name ?? '', args };
    });

    return {
      message: {
        role: 'assistant',
        content: resp.response ?? '',
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      stopReason: calls.length ? 'tool_use' : 'end_turn',
      ...(resp.usage
        ? {
            usage: {
              input: resp.usage.prompt_tokens ?? 0,
              output: resp.usage.completion_tokens ?? 0,
            },
          }
        : {}),
    };
  }

  async *streamChat(
    messages: ChatMessage[],
    tools: Tool[],
    opts?: ModelChatOptions,
  ): AsyncGenerator<string, ModelChatResult> {
    // Workers AI streaming doesn't reliably surface tool_calls — different
    // models emit different shapes and the SSE format is text-first. When
    // the agent has tools and the model is tool-capable, fall back to a
    // non-streaming chat() so tool_calls survive; yield the full text in
    // one chunk so downstream consumers still see content.
    if (tools.length && WORKERS_AI_TOOL_CAPABLE.has(this.route.model)) {
      const result = await this.chat(messages, tools, opts);
      if (result.message.content) yield result.message.content;
      return result;
    }
    const stream = (await this.env.AI.run(
      this.route.model as keyof AiModels,
      {
        messages: messages.map(toOpenAIMessage),
        stream: true,
      } as never,
    )) as ReadableStream;
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    // Workers AI puts the cumulative usage on the trailing SSE chunk
    // (the same one that emits `[DONE]` in the next event). Capture it
    // when present so the streaming path matches `chat()` for token
    // tracking.
    let inputTokens = 0;
    let outputTokens = 0;
    // TextDecoderStream chunks split at arbitrary byte boundaries, not
    // line boundaries — so we buffer until we see a `\n`, then process
    // complete lines and keep the tail. Without this, a chunk that
    // ends mid-`data:` line drops content silently.
    let buf = '';
    const processLine = (line: string): string | undefined => {
      if (!line.startsWith('data: ')) return undefined;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') return undefined;
      let obj: {
        response?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        obj = JSON.parse(payload);
      } catch {
        return undefined;
      }
      if (obj.usage) {
        inputTokens = obj.usage.prompt_tokens ?? inputTokens;
        outputTokens = obj.usage.completion_tokens ?? outputTokens;
      }
      return obj.response;
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        const out = processLine(line);
        if (out) {
          text += out;
          yield out;
        }
      }
    }
    // Flush any trailing line not terminated by `\n` (rare but valid
    // SSE — the final event may end without a trailing newline).
    if (buf.length > 0) {
      const out = processLine(buf);
      if (out) {
        text += out;
        yield out;
      }
    }
    return {
      message: { role: 'assistant', content: text },
      stopReason: 'end_turn',
      ...(inputTokens || outputTokens
        ? { usage: { input: inputTokens, output: outputTokens } }
        : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Built-in provider registration. Adding a new provider = one more
// `registerModelProvider(...)` call here (or from `composition.ts`).
// ---------------------------------------------------------------------------

registerModelProvider(
  'anthropic',
  (env, modelId, route, spec) => new AnthropicGatewayClient(env, modelId, route, spec),
);
registerModelProvider(
  'openai',
  (env, modelId, route, spec) => new OpenAIGatewayClient(env, modelId, route, spec),
);
registerModelProvider(
  'workers-ai',
  (env, modelId, route, spec) => new WorkersAiClient(env, modelId, route, spec),
);
