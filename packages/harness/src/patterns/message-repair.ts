/**
 * Render-time tool_use / tool_result pairing repair.
 *
 * The working-set message array a `SessionStrategy` renders can violate the
 * provider's tool-pairing rules — and if it does, the provider rejects the
 * whole request with a 400, permanently poisoning the thread. Three ways the
 * array goes bad, none of them repaired anywhere before this pass:
 *
 *   a) A crash mid tool-cycle leaves a dangling assistant `tool_use` with no
 *      following `tool_result`. (`wake()`/`pendingToolCalls` repair is wired
 *      only into A2A `tasks/resubscribe`, not `/chat` or `/v1`.)
 *   b) `windowed:N` / `semantic:N` slice the event log positionally and can
 *      cut a window mid-pair — an orphan `tool_result` whose `tool_use` was
 *      dropped, or a `tool_use` whose `tool_result` was dropped.
 *   c) The `queue` transport persists a stub `tool_result` and the async
 *      consumer later writes a SECOND `tool_result` with the same
 *      `tool_call_id`, so the log carries duplicate / non-adjacent results.
 *
 * Anthropic requires every assistant `tool_use` block to be answered by a
 * `tool_result` in the immediately-following user turn, and every
 * `tool_result` to reference a preceding `tool_use`. OpenAI's Chat
 * Completions surface enforces the same shape (an assistant message with
 * `tool_calls` must be followed by a `tool` message per id; a `tool` message
 * must answer a preceding `tool_calls`). `repairToolPairing` normalizes the
 * *in-memory* working set to satisfy both — it never touches the persisted
 * session log.
 *
 * The repair is intentionally conservative: it prefers **dropping** an
 * unmatched `tool_use` over synthesizing a fake `tool_result` (a fabricated
 * result the model would trust). Well-formed input is returned unchanged (same
 * array reference).
 */

import type { ChatMessage } from './types';

/**
 * Repair tool_use / tool_result pairing on a rendered working-set message
 * array. Pure — inputs are not mutated; when no repair is needed the original
 * array reference is returned.
 *
 * Rules applied, in one pass:
 *   - **Dangling tool_use** — an assistant `tool_call` with no matching
 *     `tool_result` later in the array is dropped from the assistant turn. If
 *     that empties the turn (no text content and no thinking blocks), the whole
 *     turn is dropped. We never fabricate a placeholder result.
 *   - **Orphan tool_result** — a `role: 'tool'` message whose `tool_call_id`
 *     has no preceding assistant `tool_call` is dropped.
 *   - **Duplicate tool_result** — when several `tool_result`s share a
 *     `tool_call_id`, exactly one is kept, positioned where the *first* one
 *     appeared (adjacent to its assistant turn) and carrying the *last*
 *     (most-complete — the real result over the queue stub) content.
 */
export function repairToolPairing(messages: ChatMessage[]): ChatMessage[] {
  // Index of the assistant turn that first emitted each tool_call id.
  const callTurnIndex = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (!callTurnIndex.has(tc.id)) callTurnIndex.set(tc.id, i);
      }
    }
  });

  // All tool_result positions, grouped by id, in array order.
  const resultIndicesById = new Map<string, number[]>();
  messages.forEach((m, i) => {
    if (m.role === 'tool' && m.tool_call_id) {
      const arr = resultIndicesById.get(m.tool_call_id);
      if (arr) arr.push(i);
      else resultIndicesById.set(m.tool_call_id, [i]);
    }
  });

  // A result is "valid" only if it comes after its call turn. For each id with
  // ≥1 valid result: remember the first valid position (where the kept result
  // stays, keeping it adjacent to the assistant turn) and the last valid
  // content (the real result wins over an earlier stub).
  const matchedIds = new Set<string>();
  const keptResultIndex = new Map<string, number>();
  const bestContent = new Map<string, string>();
  for (const [id, indices] of resultIndicesById) {
    const callIdx = callTurnIndex.get(id);
    if (callIdx === undefined) continue;
    const valid = indices.filter((i) => i > callIdx);
    if (valid.length === 0) continue;
    matchedIds.add(id);
    keptResultIndex.set(id, valid[0]!);
    bestContent.set(id, messages[valid[valid.length - 1]!]!.content);
  }

  const out: ChatMessage[] = [];
  let changed = false;

  messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const kept = m.tool_calls.filter((tc) => matchedIds.has(tc.id));
      if (kept.length === m.tool_calls.length) {
        out.push(m);
        return;
      }
      changed = true;
      if (kept.length === 0) {
        // Every call on this turn is dangling. Keep the turn only if it still
        // carries real content (text or thinking); otherwise drop it whole so
        // we don't emit an empty assistant turn.
        const hasContent =
          (m.content && m.content.length > 0) || (m.thinking && m.thinking.length > 0);
        if (hasContent) {
          const { tool_calls: _dropped, ...rest } = m;
          out.push(rest);
        }
        return;
      }
      out.push({ ...m, tool_calls: kept });
      return;
    }

    if (m.role === 'tool' && m.tool_call_id) {
      const id = m.tool_call_id;
      if (!matchedIds.has(id)) {
        // Orphan — no preceding assistant tool_call. Drop.
        changed = true;
        return;
      }
      if (keptResultIndex.get(id) !== i) {
        // Duplicate — a later occurrence of an id we keep elsewhere. Drop.
        changed = true;
        return;
      }
      const best = bestContent.get(id)!;
      if (best !== m.content) {
        changed = true;
        out.push({ ...m, content: best });
        return;
      }
      out.push(m);
      return;
    }

    out.push(m);
  });

  return changed ? out : messages;
}
