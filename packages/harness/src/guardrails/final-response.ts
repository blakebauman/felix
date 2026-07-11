/**
 * Output guardrails on the model's FINAL user-facing answer.
 *
 * The `applyGuardrails` / `applyJudges` wrappers only scan tool traffic — they
 * hang off the tool-executor seam. The assistant's final response (the text the
 * loop returns / streams to the caller) is never a tool call, so it needs a
 * separate interception point. This module runs, OUTSIDE the wrapper chain and
 * on the answer's `content`:
 *   1. the same content-filter pipeline (`runFilters` / the `pii` provider), and
 *   2. any judge flagged `final_response` (a Workers-AI scorer over the answer).
 *
 * Only consulted when a manifest opts `final_response` into `guardrails.targets`
 * (see `finalResponseGuardEnabled`). Off by default — enabling it is explicit.
 */

import { recordEvent } from '../audit/store';
import { currentTenantSubject } from '../limits/state';
import { recordCounter } from '../observability/metrics';
import type { ChatMessage } from '../patterns/types';
import { judgeOne } from './judge-wrap';
import { finalResponseGuardEnabled, finalResponseJudges, type Guardrails } from './models';
import { runFilters } from './pipeline';

const BLOCKED_NOTICE = '[response withheld by output policy]';
const FINAL_JUDGE_TOOL = '<final_response>';

// How many chars of *filtered* output the incremental streamer holds back
// before emitting. Any match near the live edge stays inside this window until
// it either fully resolves (and is redacted) or enough non-matching text pushes
// it out — so a match spanning a chunk boundary is caught before its bytes are
// emitted. Must exceed the longest realistic match; a single contiguous secret
// longer than this could leak its prefix (documented on the schema field).
const SAFE_TAIL_CHARS = 320;

function recordFilterBlock(
  manifestId: string,
  matches: { provider: string; fingerprint: string }[],
): void {
  const { tenantId, subject } = currentTenantSubject();
  recordEvent({
    tenantId,
    eventType: 'guardrail_block',
    principalSubject: subject,
    manifestId,
    status: matches.length ? 'matched' : 'clean',
    // `surface: 'final_response'` distinguishes this from tool input/output
    // blocks. Fingerprints only — never the raw matched text (matches the
    // tool-side contract).
    payload: { surface: 'final_response', matches },
  });
  recordCounter('orchestrator_guardrail_blocks', {
    surface: 'final_response',
    manifest_id: manifestId,
  });
}

function recordFinalJudge(
  manifestId: string,
  judge: string,
  outcome: { score: number; passed: boolean; reasoning: string },
): void {
  const { tenantId, subject } = currentTenantSubject();
  recordEvent({
    tenantId,
    eventType: 'judge_score',
    principalSubject: subject,
    manifestId,
    status: outcome.passed ? 'pass' : 'fail',
    payload: {
      source: 'final_response',
      judge,
      score: outcome.score,
      reasoning: outcome.reasoning.slice(0, 500),
    },
  });
  recordCounter('orchestrator_judge_scores', {
    judge,
    verdict: outcome.passed ? 'pass' : 'fail',
    manifest_id: manifestId,
  });
}

/**
 * Run the content filters + final-response judges over an answer string.
 * Returns the resulting content (redacted / blocked / unchanged). Emits the
 * audit + counters. Shared by `guardFinalResponse` and `guardFinalResponseText`.
 */
async function applyFinalGuards(
  content: string,
  g: Guardrails,
  manifestId: string,
): Promise<string> {
  let result = content;

  // 1. Content filters (pii). Redact or block on a match.
  if (g.providers.length > 0) {
    const { filtered, matches } = await runFilters(g.providers, result);
    if (matches.length > 0) {
      recordFilterBlock(manifestId, matches);
      if (g.final_response.on_match === 'block') return BLOCKED_NOTICE;
      result = filtered;
    }
  }

  // 2. Final-response judges. Score the (filtered) answer; a below-threshold
  //    judge blocks. A judge that can't run (no AI binding) is skipped — a
  //    missing binding must not silently block every answer.
  const judges = finalResponseJudges(g);
  for (const rule of judges) {
    const outcome = await judgeOne(rule, FINAL_JUDGE_TOOL, {}, result, manifestId);
    if (outcome === null) continue;
    recordFinalJudge(manifestId, rule.name, outcome);
    if (!outcome.passed) return BLOCKED_NOTICE;
  }

  return result;
}

/**
 * Guard the final assistant message per the manifest's `final_response` config.
 * Returns the (possibly new) message; returns the input unchanged when the
 * guard is disabled, the content is empty, or nothing fired. Only `content` is
 * touched — `thinking` / `tool_calls` / other fields are preserved so Anthropic
 * round-tripping isn't broken.
 */
export async function guardFinalResponse(
  message: ChatMessage,
  g: Guardrails | undefined,
  manifestId: string,
): Promise<ChatMessage> {
  if (!g || !finalResponseGuardEnabled(g)) return message;
  if (typeof message.content !== 'string' || message.content.length === 0) return message;
  const guarded = await applyFinalGuards(message.content, g, manifestId);
  if (guarded === message.content) return message; // unchanged — no copy
  return { ...message, content: guarded };
}

/**
 * Guard a raw final-answer string (the streaming `buffer` path accumulates
 * deltas into a string rather than a full `ChatMessage`).
 */
export async function guardFinalResponseText(
  text: string,
  g: Guardrails | undefined,
  manifestId: string,
): Promise<string> {
  if (!g || !finalResponseGuardEnabled(g) || text.length === 0) return text;
  return applyFinalGuards(text, g, manifestId);
}

/**
 * Stateful content-filter for the streaming `incremental` mode. `push(delta)`
 * returns the newly-emittable *filtered* text (holding back the last
 * `SAFE_TAIL_CHARS` so a boundary-spanning match isn't emitted early);
 * `finish()` returns the remaining tail plus the fully-filtered content and
 * records the filter block once over the whole answer. Judges are NOT run here
 * — they need the complete answer and can't retract streamed bytes, so the
 * caller runs them at the terminal message (like `passthrough`).
 */
export function makeIncrementalGuard(g: Guardrails, manifestId: string) {
  let raw = '';
  let emitted = 0; // chars of filtered output already emitted (stable prefix)
  const providers = g.providers;
  return {
    async push(delta: string): Promise<string> {
      raw += delta;
      if (providers.length === 0) {
        // No content filter — stream raw (judges run at finish on the caller).
        const chunk = raw.slice(emitted);
        emitted = raw.length;
        return chunk;
      }
      const { filtered } = await runFilters(providers, raw);
      const commit = Math.max(0, filtered.length - SAFE_TAIL_CHARS);
      if (commit <= emitted) return '';
      const chunk = filtered.slice(emitted, commit);
      emitted = commit;
      return chunk;
    },
    async finish(): Promise<{ tail: string; content: string }> {
      if (providers.length === 0) {
        return { tail: raw.slice(emitted), content: raw };
      }
      const { filtered, matches } = await runFilters(providers, raw);
      if (matches.length > 0) recordFilterBlock(manifestId, matches);
      const tail = filtered.length > emitted ? filtered.slice(emitted) : '';
      return { tail, content: filtered };
    },
  };
}
