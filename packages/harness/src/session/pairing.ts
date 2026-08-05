/**
 * Keeping tool-call exchanges intact when a strategy selects a subset of the
 * session log.
 *
 * An assistant turn that calls a tool and the `tool` turn carrying the result
 * are two separate session events, but to a provider they are one indivisible
 * exchange: Anthropic rejects a `tool_result` whose `tool_use` it cannot see,
 * and OpenAI rejects a `role: 'tool'` message whose `tool_call_id` was never
 * declared. Both are hard 400s, not degraded answers.
 *
 * Every strategy that renders less than the whole log can split that pair.
 * `windowed:N` slices the last N events, `summarizing:N` keeps the last N raw,
 * and `semantic:N` picks by relevance and so is under no obligation to select
 * neighbours at all. The bug is invisible in testing with short conversations
 * and appears once a real one grows past the window — at which point every
 * subsequent turn fails until the boundary happens to move.
 *
 * This repairs a selection rather than constraining how strategies choose:
 * given whatever a strategy picked, pull in the missing half of any exchange it
 * split. Widening the window slightly is the right trade against a request the
 * provider refuses outright.
 */

import type { SessionEvent } from './types';

/** Tool-call ids an event declares (assistant side). */
function declaredIds(event: SessionEvent): string[] {
  return (event.tool_calls ?? []).map((c) => c.id);
}

/**
 * Add back whichever half of a tool exchange the selection is missing.
 *
 * `all` is the full ordered log; `selected` is the strategy's choice from it.
 * The result is seq-ordered and deduplicated, and is a superset of `selected` —
 * nothing a strategy deliberately kept is ever dropped.
 */
export function completeToolGroups(
  all: readonly SessionEvent[],
  selected: readonly SessionEvent[],
): SessionEvent[] {
  if (selected.length === 0) return [];

  // Index the full log once: which event declared each tool_call id, and which
  // events carry its results.
  const declaringEvent = new Map<string, SessionEvent>();
  const resultEvents = new Map<string, SessionEvent[]>();
  for (const event of all) {
    for (const id of declaredIds(event)) {
      if (!declaringEvent.has(id)) declaringEvent.set(id, event);
    }
    const resultId = event.tool_call_id;
    if (resultId) {
      const list = resultEvents.get(resultId);
      if (list) list.push(event);
      else resultEvents.set(resultId, [event]);
    }
  }

  const bySeq = new Map<number, SessionEvent>();
  // Worklist rather than one pass over `selected`: pulling in a declaring
  // assistant can itself require more events. An assistant that made three
  // calls needs ALL three results — providers reject a tool_use whose answers
  // are only partly present — so selecting one result has to cascade to its
  // siblings through the assistant that declared them.
  const queue: SessionEvent[] = [];
  const enqueue = (event: SessionEvent) => {
    if (bySeq.has(event.seq)) return;
    bySeq.set(event.seq, event);
    queue.push(event);
  };
  for (const event of selected) enqueue(event);

  while (queue.length > 0) {
    const event = queue.pop() as SessionEvent;
    // A result without its call: pull the declaring assistant forward.
    const resultId = event.tool_call_id;
    if (resultId) {
      const declaring = declaringEvent.get(resultId);
      if (declaring) enqueue(declaring);
    }
    // A call without its results: pull them in. An id with no result anywhere
    // in the log is a genuinely pending call — that state belongs to the log
    // itself, not to how this strategy sliced it, so it is left alone.
    for (const id of declaredIds(event)) {
      for (const result of resultEvents.get(id) ?? []) enqueue(result);
    }
  }

  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * True when `messages`-shaped events would present a provider with half an
 * exchange. Exported for tests and for anything that wants to assert the
 * invariant rather than assume it.
 */
export function hasBrokenToolPairing(events: readonly SessionEvent[]): boolean {
  const declared = new Set<string>();
  for (const event of events) for (const id of declaredIds(event)) declared.add(id);
  return events.some((e) => e.tool_call_id !== undefined && !declared.has(e.tool_call_id));
}
