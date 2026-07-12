/**
 * Wrap tools with per-run execution caps.
 *
 * The mutable counter container is the `limitState` on the AsyncLocalStorage
 * request context; the middleware installs a fresh one on every request, so
 * counter values are request-isolated by construction.
 */

import { recordEvent } from '../audit/store';
import type { LimitState } from '../context';
import { recordCounter } from '../observability/metrics';
import type { ModelClient } from '../patterns/model';
import type { ChatMessage } from '../patterns/types';
import { wrapExecutor } from '../tools/executor';
import { denyOutput, type Tool, type ToolInvocationCtx, type ToolOutput } from '../tools/types';
import { anyLimit, clampLimits, type Limits } from './models';
import { currentLimitState, currentTenantSubject } from './state';

type LimitName =
  | 'max_tool_calls'
  | 'max_wall_clock_seconds'
  | 'max_peer_hops'
  | 'max_input_tokens'
  | 'max_output_tokens';

function recordBreach(opts: {
  manifestId: string;
  toolName: string;
  /** Transport of the inner tool that breached. Omitted for model-side
   *  breaches (preflight / cumulative token cap) where there is no tool. */
  transport?: string;
  limit: LimitName;
  cap: number;
  observed: number;
}): ToolOutput {
  const { tenantId, subject } = currentTenantSubject();
  recordEvent({
    tenantId,
    eventType: 'limit_exceeded',
    principalSubject: subject,
    manifestId: opts.manifestId,
    status: 'denied',
    payload: {
      tool: opts.toolName,
      limit: opts.limit,
      cap: opts.cap,
      observed: opts.observed,
      ...(opts.transport ? { transport: opts.transport } : {}),
    },
  });
  recordCounter('orchestrator_limit_breaches', {
    limit: opts.limit,
    manifest_id: opts.manifestId,
    ...(opts.transport ? { transport: opts.transport } : {}),
  });
  return denyOutput(
    `[limit exceeded] ${opts.limit} cap of ${opts.cap} reached at tool '${opts.toolName}'`,
    'limits',
  );
}

/**
 * Pre-flight budget check. Projects the input-token cost of the next
 * model call via `model.countTokens` (Anthropic's free
 * `/v1/messages/count_tokens` endpoint) and compares
 * `state.tokens.input + projected` against `max_input_tokens`. Returns
 * a deny string when the projected request would breach the cap,
 * undefined otherwise. Gated by `limits.precount`; also a no-op when
 * the route's client doesn't implement `countTokens` (OpenAI / Workers
 * AI) — those fall back to the post-call accumulator in
 * `checkTokenBudget`. If the count call itself fails the breach is
 * NOT recorded; callers proceed with the request and rely on the
 * post-call check, since denying on an upstream blip would be worse
 * than charging for one more turn.
 */
export async function checkPreflightTokenBudget(
  model: ModelClient,
  messages: ChatMessage[],
  tools: Tool[],
  limits: Limits,
  manifestId: string,
): Promise<string | undefined> {
  if (!limits.precount) return undefined;
  const clamped = clampLimits(limits);
  if (clamped.max_input_tokens == null) return undefined;
  if (!model.countTokens) return undefined;
  const state = currentLimitState();
  if (!state) return undefined;
  let projected: number;
  try {
    projected = await model.countTokens(messages, tools, { signal: state.abortController.signal });
  } catch {
    return undefined;
  }
  const total = state.tokens.input + projected;
  if (total < clamped.max_input_tokens) return undefined;
  const out = recordBreach({
    manifestId,
    toolName: '<model:preflight>',
    limit: 'max_input_tokens',
    cap: clamped.max_input_tokens,
    observed: total,
  });
  return typeof out === 'string' ? out : out.content;
}

/**
 * Check token caps against the cumulative spend in `LimitState.tokens`.
 * Returns a deny string when over budget, undefined when ok. Patterns
 * call this immediately before each model.chat / model.streamChat — the
 * one place tokens actually accrue.
 */
export function checkTokenBudget(limits: Limits, manifestId: string): string | undefined {
  const state = currentLimitState();
  if (!state) return undefined;
  // Clamp to the absolute ceiling so a schema-bypassing caller can't raise the
  // token budget past it (no-op on the Zod path, which is already ≤ ceiling).
  const clamped = clampLimits(limits);
  if (clamped.max_input_tokens != null && state.tokens.input >= clamped.max_input_tokens) {
    const out = recordBreach({
      manifestId,
      toolName: '<model>',
      limit: 'max_input_tokens',
      cap: clamped.max_input_tokens,
      observed: state.tokens.input,
    });
    return typeof out === 'string' ? out : out.content;
  }
  if (clamped.max_output_tokens != null && state.tokens.output >= clamped.max_output_tokens) {
    const out = recordBreach({
      manifestId,
      toolName: '<model>',
      limit: 'max_output_tokens',
      cap: clamped.max_output_tokens,
      observed: state.tokens.output,
    });
    return typeof out === 'string' ? out : out.content;
  }
  return undefined;
}

/**
 * Schedule the AbortController in `limitState` to fire when the wall-clock
 * limit elapses. Idempotent — only the first call per request arms a timer.
 * Without this, a tool already past the budget runs to completion; only the
 * *next* call would see the breach. With it, cooperating tools (anything
 * passing `ctx.signal` through to fetch / DO calls) get cancelled mid-flight.
 */
function armWallClockAbort(state: LimitState, limits: Limits, manifestId: string): void {
  if (state.wallClockTimerId !== undefined) return;
  if (limits.max_wall_clock_seconds == null) return;
  const remainingMs = limits.max_wall_clock_seconds * 1000 - (Date.now() - state.startedAt);
  const fire = () => {
    if (state.abortController.signal.aborted) return;
    state.abortController.abort(
      new DOMException(
        `[limit exceeded] max_wall_clock_seconds (${limits.max_wall_clock_seconds}) — manifest ${manifestId}`,
        'AbortError',
      ),
    );
  };
  if (remainingMs <= 0) {
    fire();
    return;
  }
  state.wallClockTimerId = setTimeout(fire, remainingMs);
}

function wrapOne(inner: Tool, limits: Limits, manifestId: string): Tool {
  const isPeerTool = inner.isPeer || inner.name.startsWith('peer_');
  return {
    ...inner,
    executor: wrapExecutor(inner.executor, async (args, ctx) => {
      const state = currentLimitState();
      if (!state) return inner.executor.execute(args, ctx);
      armWallClockAbort(state, limits, manifestId);

      if (limits.max_wall_clock_seconds != null) {
        const elapsed = (Date.now() - state.startedAt) / 1000;
        if (elapsed > limits.max_wall_clock_seconds) {
          return recordBreach({
            manifestId,
            toolName: inner.name,
            transport: inner.executor.transport,
            limit: 'max_wall_clock_seconds',
            cap: limits.max_wall_clock_seconds,
            observed: elapsed,
          });
        }
      }
      if (limits.max_tool_calls != null && state.toolCalls >= limits.max_tool_calls) {
        return recordBreach({
          manifestId,
          toolName: inner.name,
          transport: inner.executor.transport,
          limit: 'max_tool_calls',
          cap: limits.max_tool_calls,
          observed: state.toolCalls,
        });
      }
      if (isPeerTool && limits.max_peer_hops != null && state.peerHops >= limits.max_peer_hops) {
        return recordBreach({
          manifestId,
          toolName: inner.name,
          transport: inner.executor.transport,
          limit: 'max_peer_hops',
          cap: limits.max_peer_hops,
          observed: state.peerHops,
        });
      }

      state.toolCalls += 1;
      if (isPeerTool) state.peerHops += 1;
      // Inject the abort signal so tools that opt in (fetch, DO calls)
      // cancel mid-flight when the wall-clock fires or the request ends.
      const downstreamCtx: ToolInvocationCtx = {
        ...ctx,
        signal: ctx?.signal ?? state.abortController.signal,
      };
      return inner.executor.execute(args, downstreamCtx);
    }),
  };
}

export function applyLimits(tools: Tool[], limits: Limits, manifestId: string): Tool[] {
  // Defense-in-depth: clamp every declared cap to its absolute ceiling so a
  // caller that built the manifest without Zod can't exceed it. No-op on the
  // Zod-validated path (already ≤ ceiling); preserves null (no-cap) semantics.
  const clamped = clampLimits(limits);
  if (!anyLimit(clamped)) return [...tools];
  return tools.map((t) => wrapOne(t, clamped, manifestId));
}
