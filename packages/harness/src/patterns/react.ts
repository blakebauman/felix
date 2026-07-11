/**
 * react pattern — the canonical tool-calling loop.
 *
 *   user → model → if tool_calls → execute → feed results back → model …
 *
 * When `input.threadId` is set and the manifest declares a non-`none`
 * checkpointer (resolved at build time), the loop:
 *   1. opens a `Session` for that thread and asks the `SessionStrategy`
 *      to render the working-set messages — full replay, windowed, or
 *      future summarized — without touching the strategy code itself,
 *   2. appends each new caller / assistant / tool event incrementally so
 *      a worker eviction mid-loop leaves a coherent prefix on disk,
 *   3. lets a future invocation with the same threadId resume the
 *      conversation without the caller re-supplying history.
 *
 * Persistence is fire-and-forget via `execCtx.waitUntil` so DO round-trips
 * don't block the LLM step. Each step flushes its batch of newly produced
 * events in one `POST /events` call.
 *
 * Two distinct caps bound this loop — they cover different concerns:
 *   - `recursion_limit` (manifest) bounds **model turns**. One model
 *      response that emits 5 tool calls counts as one step. This is the
 *      anti-runaway-conversation cap.
 *   - `limits.max_tool_calls` (governance) bounds **individual tool
 *     invocations** across the entire run. This is the per-call budget
 *     enforced by the limits wrapper inside dispatchToolCall.
 * Set both: `recursion_limit` to bound the conversation depth,
 * `max_tool_calls` to bound the work the loop is allowed to do.
 *
 * Tool calls run sequentially to keep audit ordering deterministic.
 */

import { recordEvent } from '../audit/store';
import { getContext, requireContext } from '../context';
import type { Env } from '../env';
import { guardFinalResponse } from '../guardrails/final-response';
import {
  DEFAULT_GUARDRAILS,
  finalResponseGuardEnabled,
  type Guardrails,
} from '../guardrails/models';
import { ABSOLUTE_LIMITS, clampLimit, DEFAULT_LIMITS, type Limits } from '../limits/models';
import { currentSignal } from '../limits/state';
import { checkPreflightTokenBudget, checkTokenBudget } from '../limits/wrap';
import type { Model } from '../manifests/schema';
import { recordCounter } from '../observability/metrics';
import { withSpan } from '../observability/tracing';
import { noopSessionStore, persistFireAndForget } from '../session/do-session';
import { fullReplaySessionStrategy } from '../session/strategies';
import {
  type AppendableEvent,
  chatMessageToEvent,
  type Session,
  type SessionStore,
  type SessionStrategy,
} from '../session/types';
import { type ArtifactsOpts, DEFAULT_ARTIFACTS_OPTS, spillArtifact } from '../tools/artifacts';
import { inferErrorCode, readToolErrorCode } from '../tools/errors';
import { selectTopKTools, type ToolsRetrievalOpts } from '../tools/retrieval';
import { isWrapperDeny, type Tool, type ToolInput } from '../tools/types';
import { buildModel, type ModelChatResult, recordUsage } from './model';
import { registerPattern } from './registry';
import type { Agent, ChatMessage, InvokeInput, InvokeResult, StreamEvent, ToolCall } from './types';

/**
 * Cap on the originating user input captured onto `tool_call` audit rows
 * for continuous-eval replay. Bounds audit-row growth; the replay only
 * needs the gist of the turn, not an unbounded prompt.
 */
const MAX_AUDIT_USER_INPUT = 2000;

/** Most recent non-empty user turn, bounded — the replay seed for continuous eval. */
function lastUserText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === 'user' && typeof m.content === 'string' && m.content.length > 0) {
      return m.content.slice(0, MAX_AUDIT_USER_INPUT);
    }
  }
  return '';
}

export interface BuildReactOptions {
  env: Env;
  modelSpec: Model;
  tools: Tool[];
  systemPrompt: string;
  manifestId: string;
  manifestVersion: string;
  recursionLimit?: number | null;
  /** Resolved at build time from `manifest.spec.memory.checkpointer`. */
  sessionStore?: SessionStore | null;
  /** Resolved at build time from `manifest.spec.session.strategy`. */
  sessionStrategy?: SessionStrategy | null;
  /**
   * Manifest limits. Tool-call / wall-clock / peer-hop caps are enforced
   * inside `applyLimits` (the wrapper sees every invocation); token caps
   * are checked here in the react loop right before each model call,
   * since that's the only place token usage actually accrues.
   */
  limits?: Limits;
  /**
   * Just-in-time tool retrieval. When `enabled: true`, the loop
   * filters `tools` down to the top-K most relevant per turn via a
   * BGE embedding similarity to the recent conversation. Disabled by
   * default to preserve the existing pass-through behavior.
   */
  toolsRetrieval?: ToolsRetrievalOpts | null;
  /**
   * Reference-based artifacts. When `enabled: true`, tool results
   * that exceed `threshold_chars` are spilled to R2 and the model
   * sees a `[artifact:REF]` stub; the auto-injected `fetch_artifact`
   * tool reads back. Disabled by default.
   */
  artifacts?: ArtifactsOpts | null;
  /**
   * Guardrails config. Only the final-response guard is consulted here — the
   * tool-side `providers` / `judges` run inside `applyGuardrails` / `applyJudges`
   * at build time. When `targets` includes `final_response`, the loop filters
   * the model's final answer before returning / streaming it.
   */
  guardrails?: Guardrails | null;
}

const DEFAULT_RECURSION = 10;

export function buildReactAgent(opts: BuildReactOptions): Agent {
  const model = buildModel(opts.env, opts.modelSpec);
  const toolMap = new Map(opts.tools.map((t) => [t.name, t]));
  // Clamp the manifest-declared recursion against the absolute ceiling
  // even though the schema enforces the same cap — defense in depth.
  const recursion = clampLimit(
    opts.recursionLimit ?? DEFAULT_RECURSION,
    ABSOLUTE_LIMITS.recursion_limit,
  );
  const sessionStore: SessionStore = opts.sessionStore ?? noopSessionStore;
  const strategy: SessionStrategy = opts.sessionStrategy ?? fullReplaySessionStrategy;
  const limits: Limits = opts.limits ?? DEFAULT_LIMITS;
  const artifactsOpts: ArtifactsOpts = opts.artifacts ?? DEFAULT_ARTIFACTS_OPTS;
  const guardrails: Guardrails = opts.guardrails ?? DEFAULT_GUARDRAILS;
  const guardFinal = finalResponseGuardEnabled(guardrails);

  /**
   * Dispatch a single tool call. Returns `{ kind: 'ok', message }` for the
   * default stringified-error behavior, and `{ kind: 'fatal', message }`
   * when a tool with `fatal: true` throws — the loop bails out instead of
   * feeding the error back to the model. Unknown tools are non-fatal so
   * a hallucinated tool name doesn't kill the run.
   */
  async function dispatchToolCall(
    call: ToolCall,
    threadId?: string,
    userInput?: string,
  ): Promise<{ kind: 'ok' | 'fatal'; message: ChatMessage }> {
    // The originating user turn, captured on every `tool_call` audit row
    // so continuous eval (jobs/continuous-eval.ts) can replay real
    // production inputs through a candidate manifest without re-deriving
    // them from the session log. Bounded and only attached when present.
    const userInputField = userInput ? { user_input: userInput } : {};
    return withSpan(
      'tool.call',
      async (span) => {
        const startedAt = Date.now();
        const reqCtx = getContext();
        const tenantId = reqCtx?.auth.principal.tenantId ?? 'default';
        const subject = reqCtx?.auth.principal.subject ?? '';
        // Canary variant (when this request resolved to one), stamped on every
        // tool_call row so the anomaly detector attributes spikes per-variant.
        const variantField = reqCtx?.manifestVariant
          ? { manifest_variant: reqCtx.manifestVariant }
          : {};

        const tool = toolMap.get(call.name);
        if (!tool) {
          span.setAttribute('tool.transport', 'unknown');
          span.setAttribute('status', 'error');
          span.setAttribute('error_code', 'invalid_arguments');
          recordEvent({
            tenantId,
            eventType: 'tool_call',
            principalSubject: subject,
            manifestId: opts.manifestId,
            status: 'error',
            payload: {
              tool: call.name,
              transport: 'unknown',
              args: call.args,
              error: 'unknown tool',
              error_code: 'invalid_arguments',
              duration_ms: Date.now() - startedAt,
              ...userInputField,
              ...variantField,
            },
          });
          recordCounter('orchestrator_tool_calls', {
            transport: 'unknown',
            status: 'error',
            error_code: 'invalid_arguments',
            manifest_id: opts.manifestId,
          });
          return {
            kind: 'ok' as const,
            message: {
              role: 'tool' as const,
              tool_call_id: call.id,
              name: call.name,
              content: `[error/invalid_arguments] unknown tool: ${call.name}`,
            },
          };
        }
        span.setAttribute('tool.transport', tool.executor.transport);
        try {
          // Pass the request-scoped abort signal even when no limits wrapper is
          // configured — tools that opt in (e.g. fetch with `{ signal }`) get
          // cancelled when the request unwinds.
          const signal = reqCtx?.limitState?.abortController.signal;
          const result = await tool.executor.execute(call.args as ToolInput, {
            manifestId: opts.manifestId,
            toolCallId: call.id,
            ...(threadId ? { threadId } : {}),
            ...(signal ? { signal } : {}),
          });
          let str = typeof result === 'string' ? result : result.content;
          // Artifact spill — when enabled and the result
          // overflows `threshold_chars`, write the full content to R2
          // and replace the model-facing string with a stub. The
          // `fetch_artifact` tool (auto-injected by the builder) lets
          // the model read back the full content windowed.
          if (
            artifactsOpts.enabled &&
            !isWrapperDeny(result) &&
            str.length > artifactsOpts.threshold_chars &&
            threadId
          ) {
            str = await spillArtifact(
              opts.env,
              artifactsOpts,
              { tenantId, threadId, toolCallId: call.id },
              str,
            );
          }
          // Skip the tool_call audit when a governance wrapper denied — that
          // wrapper already emitted its own outcome event (policy_decision,
          // limit_exceeded, guardrail_block, approval_request/decision). A
          // redundant `tool_call: ok` here would lie about what happened.
          if (isWrapperDeny(result)) {
            span.setAttribute('status', 'denied');
          } else {
            const errorCode = readToolErrorCode(result);
            if (errorCode) {
              span.setAttribute('status', 'error');
              span.setAttribute('error_code', errorCode);
              recordEvent({
                tenantId,
                eventType: 'tool_call',
                principalSubject: subject,
                manifestId: opts.manifestId,
                status: 'error',
                payload: {
                  tool: call.name,
                  transport: tool.executor.transport,
                  args: call.args,
                  error: str.slice(0, 200),
                  error_code: errorCode,
                  duration_ms: Date.now() - startedAt,
                  ...userInputField,
                  ...variantField,
                },
              });
              recordCounter('orchestrator_tool_calls', {
                transport: tool.executor.transport,
                status: 'error',
                error_code: errorCode,
                manifest_id: opts.manifestId,
              });
            } else {
              span.setAttribute('status', 'ok');
              recordEvent({
                tenantId,
                eventType: 'tool_call',
                principalSubject: subject,
                manifestId: opts.manifestId,
                status: 'ok',
                payload: {
                  tool: call.name,
                  transport: tool.executor.transport,
                  args: call.args,
                  output_preview: str.slice(0, 200),
                  duration_ms: Date.now() - startedAt,
                  ...userInputField,
                  ...variantField,
                },
              });
              recordCounter('orchestrator_tool_calls', {
                transport: tool.executor.transport,
                status: 'ok',
                manifest_id: opts.manifestId,
              });
            }
          }
          return {
            kind: 'ok' as const,
            message: {
              role: 'tool' as const,
              tool_call_id: call.id,
              name: call.name,
              content: str,
            },
          };
        } catch (err) {
          const message = String((err as Error).message ?? err);
          const code = inferErrorCode(err);
          const content = `[tool error/${code}] ${message}`;
          span.setAttribute('status', 'error');
          span.setAttribute('error_code', code);
          recordEvent({
            tenantId,
            eventType: 'tool_call',
            principalSubject: subject,
            manifestId: opts.manifestId,
            status: 'error',
            payload: {
              tool: call.name,
              transport: tool.executor.transport,
              args: call.args,
              error: message,
              error_code: code,
              duration_ms: Date.now() - startedAt,
              ...userInputField,
              ...variantField,
            },
          });
          recordCounter('orchestrator_tool_calls', {
            transport: tool.executor.transport,
            status: 'error',
            error_code: code,
            manifest_id: opts.manifestId,
          });
          return {
            kind: tool.fatal ? ('fatal' as const) : ('ok' as const),
            message: {
              role: 'tool' as const,
              tool_call_id: call.id,
              name: call.name,
              content,
            },
          };
        }
      },
      {
        'tool.name': call.name,
        'tool.call_id': call.id,
        manifest_id: opts.manifestId,
      },
    );
  }

  function persistAsync(session: Session, messages: readonly ChatMessage[]): void {
    if (messages.length === 0) return;
    const events: AppendableEvent[] = messages
      .filter((m) => m.role !== 'system')
      .map(chatMessageToEvent);
    persistFireAndForget(session, events, { manifestId: opts.manifestId });
  }

  function trackUsage(result: ModelChatResult): void {
    recordUsage(result, { manifestId: opts.manifestId, modelId: opts.modelSpec.id });
  }

  return {
    tools: opts.tools,
    pattern: 'react',
    manifestId: opts.manifestId,
    manifestVersion: opts.manifestVersion,

    async invoke(input: InvokeInput): Promise<InvokeResult> {
      requireContext();
      const session = sessionStore.open(input.threadId ?? '');
      const messages = await strategy.render(session, input.messages, {
        systemPrompt: opts.systemPrompt,
        model,
      });

      // Persist the new caller-supplied turns (everything past history).
      // System messages are dropped inside persistAsync.
      persistAsync(session, input.messages);
      const originatingInput = lastUserText(input.messages);

      for (let step = 0; step < recursion; step += 1) {
        // JIT tool retrieval — per-turn filter to the top-K most
        // relevant tools when enabled. The full toolMap stays available
        // for dispatch (dispatchToolCall reads from it), so a model
        // hallucinated tool name still routes correctly through the
        // unknown-tool audit path.
        const turnTools = await selectTopKTools(opts.tools, messages, opts.toolsRetrieval);
        const preDeny =
          (await checkPreflightTokenBudget(model, messages, turnTools, limits, opts.manifestId)) ??
          checkTokenBudget(limits, opts.manifestId);
        if (preDeny) {
          const fallback: ChatMessage = { role: 'assistant', content: preDeny };
          messages.push(fallback);
          persistAsync(session, [fallback]);
          return { messages, final: fallback };
        }
        const result = await model.chat(messages, turnTools, { signal: currentSignal() });
        trackUsage(result);
        messages.push(result.message);

        if (result.stopReason !== 'tool_use' || !result.message.tool_calls?.length) {
          // Guard the final user-facing answer (no-op unless `final_response`
          // is a target). Replace the pushed message + persist the guarded copy
          // so the redaction is what the caller and the session log see.
          const guarded = await guardFinalResponse(result.message, guardrails, opts.manifestId);
          messages[messages.length - 1] = guarded;
          persistAsync(session, [guarded]);
          return { messages, final: guarded };
        }

        const newMessages: ChatMessage[] = [result.message];
        let fatal: ChatMessage | null = null;
        for (const call of result.message.tool_calls) {
          const dispatched = await dispatchToolCall(call, input.threadId, originatingInput);
          messages.push(dispatched.message);
          newMessages.push(dispatched.message);
          if (dispatched.kind === 'fatal') {
            fatal = dispatched.message;
            break;
          }
        }
        persistAsync(session, newMessages);
        if (fatal) return { messages, final: fatal };
      }
      const fallback: ChatMessage = {
        role: 'assistant',
        content: `[recursion limit reached: ${recursion} model turns — raise recursion_limit or set max_tool_calls to bound earlier]`,
      };
      messages.push(fallback);
      persistAsync(session, [fallback]);
      return { messages, final: fallback };
    },

    async *streamEvents(input: InvokeInput): AsyncGenerator<StreamEvent> {
      requireContext();
      const session = sessionStore.open(input.threadId ?? '');
      const messages = await strategy.render(session, input.messages, {
        systemPrompt: opts.systemPrompt,
        model,
      });
      persistAsync(session, input.messages);
      const originatingInput = lastUserText(input.messages);

      // Stamp the terminal event with the turn's cumulative token usage so
      // clients can show per-turn cost. `limitState.tokens` accrues across every
      // model call in this request (react sub-steps included) via recordUsage.
      const withUsage = <T extends object>(
        output: T,
      ): T & { usage?: { input: number; output: number } } => {
        const t = getContext()?.limitState.tokens;
        return t ? { ...output, usage: { input: t.input, output: t.output } } : output;
      };

      for (let step = 0; step < recursion; step += 1) {
        const turnTools = await selectTopKTools(opts.tools, messages, opts.toolsRetrieval);
        const preDeny =
          (await checkPreflightTokenBudget(model, messages, turnTools, limits, opts.manifestId)) ??
          checkTokenBudget(limits, opts.manifestId);
        if (preDeny) {
          const fallback: ChatMessage = { role: 'assistant', content: preDeny };
          messages.push(fallback);
          persistAsync(session, [fallback]);
          yield {
            event: 'on_chain_end',
            data: { output: withUsage({ messages, final: fallback }) },
          };
          return;
        }
        // streamChat yields text deltas and **returns** the final
        // ModelChatResult (with any tool_calls) — so a single API call
        // covers both the UX stream and the structured result. Earlier
        // versions made a second `chat()` call which doubled cost and
        // dropped tool_calls on Workers AI; this avoids both.
        const stream = model.streamChat(messages, turnTools, { signal: currentSignal() });
        let result: ModelChatResult;
        // In `buffer` mode we hold text deltas back so a secret can't stream to
        // the client before the final-response guard runs. We don't know a turn
        // is terminal until the stream returns, so every turn's deltas buffer;
        // intermediate (tool-use) turns flush their buffer unguarded afterward.
        const bufferMode = guardFinal && guardrails.final_response.streaming === 'buffer';
        let buffered = '';
        while (true) {
          const next = await stream.next();
          if (next.done) {
            result = next.value;
            break;
          }
          if (next.value) {
            if (bufferMode) buffered += next.value;
            else yield { event: 'on_chat_model_stream', data: { chunk: { content: next.value } } };
          }
        }
        trackUsage(result);
        messages.push(result.message);

        const isTerminal = result.stopReason !== 'tool_use' || !result.message.tool_calls?.length;

        if (isTerminal) {
          let finalMsg = result.message;
          if (guardFinal) {
            finalMsg = await guardFinalResponse(result.message, guardrails, opts.manifestId);
            messages[messages.length - 1] = finalMsg;
            if (!bufferMode && finalMsg !== result.message) {
              // passthrough: the raw (unfiltered) deltas already went to the
              // client; only the persisted/returned copy is guarded. Surface
              // that the streamed bytes escaped the filter.
              recordCounter('orchestrator_final_guard_skipped', {
                reason: 'streaming_passthrough',
                manifest_id: opts.manifestId,
              });
            }
          }
          // buffer mode held the deltas — emit the guarded answer as one chunk.
          if (bufferMode && finalMsg.content) {
            yield {
              event: 'on_chat_model_stream',
              data: { chunk: { content: finalMsg.content } },
            };
          }
          persistAsync(session, [finalMsg]);
          yield {
            event: 'on_chain_end',
            data: { output: withUsage({ messages, final: finalMsg }) },
          };
          return;
        }

        // Non-terminal turn: in buffer mode, flush any intermediate assistant
        // text now (it re-enters the loop, it's not the final answer).
        if (bufferMode && buffered) {
          yield { event: 'on_chat_model_stream', data: { chunk: { content: buffered } } };
        }

        const newMessages: ChatMessage[] = [result.message];
        let fatal: ChatMessage | null = null;
        // `isTerminal` was false, so tool_calls is present; `?? []` keeps the
        // narrowing explicit for TS.
        for (const call of result.message.tool_calls ?? []) {
          yield { event: 'on_tool_start', data: { name: call.name, input: call.args } };
          const dispatched = await dispatchToolCall(call, input.threadId, originatingInput);
          messages.push(dispatched.message);
          newMessages.push(dispatched.message);
          yield {
            event: 'on_tool_end',
            data: { name: call.name, output: dispatched.message.content },
          };
          if (dispatched.kind === 'fatal') {
            fatal = dispatched.message;
            break;
          }
        }
        persistAsync(session, newMessages);
        if (fatal) {
          yield { event: 'on_chain_end', data: { output: withUsage({ messages, final: fatal }) } };
          return;
        }
      }
    },
  };
}

registerPattern('react', (ctx) =>
  buildReactAgent({
    env: ctx.env,
    modelSpec: ctx.modelSpec,
    tools: ctx.tools,
    systemPrompt: ctx.systemPrompt,
    manifestId: ctx.manifestId,
    manifestVersion: ctx.manifestVersion,
    recursionLimit: ctx.recursionLimit ?? null,
    sessionStore: ctx.sessionStore ?? null,
    sessionStrategy: ctx.sessionStrategy ?? null,
    limits: ctx.limits,
    toolsRetrieval: ctx.manifest.spec.tools_retrieval,
    artifacts: ctx.manifest.spec.artifacts,
    guardrails: ctx.manifest.spec.guardrails,
  }),
);
