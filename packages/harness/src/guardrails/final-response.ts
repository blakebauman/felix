/**
 * Output guardrails on the model's FINAL user-facing answer.
 *
 * The `applyGuardrails` / `applyJudges` wrappers only scan tool traffic — they
 * hang off the tool-executor seam. The assistant's final response (the text the
 * react loop returns / streams to the caller) is never a tool call, so it needs
 * a separate interception point. `guardFinalResponse` runs the same filter
 * pipeline (`runFilters` / the `pii` provider) over the answer's `content`,
 * OUTSIDE the wrapper chain, so it never touches the `denyOutput` / wrapper-deny
 * contract.
 *
 * Only consulted when a manifest opts `final_response` into `guardrails.targets`
 * (see `finalResponseGuardEnabled`). Off by default — enabling it is explicit.
 */

import { recordEvent } from '../audit/store';
import { currentTenantSubject } from '../limits/state';
import { recordCounter } from '../observability/metrics';
import type { ChatMessage } from '../patterns/types';
import { finalResponseGuardEnabled, type Guardrails } from './models';
import { runFilters } from './pipeline';

const BLOCKED_NOTICE = '[response withheld by output policy]';

function recordFinalBlock(
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

/**
 * Filter the final assistant message per the manifest's `final_response`
 * config. Returns the (possibly new) message; returns the input unchanged when
 * the guard is disabled, the content is empty, or nothing matched. Only
 * `content` is touched — `thinking` / `tool_calls` / other fields are preserved
 * so Anthropic round-tripping isn't broken.
 */
export async function guardFinalResponse(
  message: ChatMessage,
  g: Guardrails | undefined,
  manifestId: string,
): Promise<ChatMessage> {
  if (!g || !finalResponseGuardEnabled(g)) return message;
  if (typeof message.content !== 'string' || message.content.length === 0) return message;

  const { filtered, matches } = await runFilters(g.providers, message.content);
  if (matches.length === 0) return message; // clean — no audit noise, no copy

  recordFinalBlock(manifestId, matches);
  const content = g.final_response.on_match === 'block' ? BLOCKED_NOTICE : filtered;
  return { ...message, content };
}

/**
 * Filter a raw final-answer string (the streaming `buffer` path accumulates
 * deltas into a string rather than a full `ChatMessage`). Returns the guarded
 * text. Emits the same audit/counter as `guardFinalResponse` on a match.
 */
export async function guardFinalResponseText(
  text: string,
  g: Guardrails | undefined,
  manifestId: string,
): Promise<string> {
  if (!g || !finalResponseGuardEnabled(g) || text.length === 0) return text;
  const { filtered, matches } = await runFilters(g.providers, text);
  if (matches.length === 0) return text;
  recordFinalBlock(manifestId, matches);
  return g.final_response.on_match === 'block' ? BLOCKED_NOTICE : filtered;
}
