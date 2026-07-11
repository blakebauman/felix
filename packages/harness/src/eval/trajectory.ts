/**
 * Trajectory scoring — gate that fires *before* the LLM judge.
 *
 * The runner extracts the tool-call sequence from an `InvokeResult`
 * (assistant turns with `tool_calls`), checks it against the rubric's
 * `TrajectoryRubric`, and short-circuits to a fail when any gate
 * trips. This catches the most expensive regression class — the agent
 * reaches the right final answer via a wasteful or unsafe path —
 * without paying for a judge call.
 *
 * Each gate is checked independently and returns the first failure;
 * downstream callers attach the reasoning to the item's `reasoning`
 * field so an operator can trace the regression to the exact gate.
 */

import type { ChatMessage } from '../patterns/types';
import type { TrajectoryRubric } from './types';

export interface TrajectoryResult {
  passed: boolean;
  tool_call_count: number;
  /** Sequence of tool names in invocation order. */
  trajectory: string[];
  /** Set when `passed === false`; explains which gate fired. */
  reason?: string;
}

/**
 * Flatten assistant turns into the in-order tool-call sequence.
 * Multi-call turns contribute their calls in array order, mirroring
 * the dispatch order in `react.ts`.
 */
export function extractToolCallSequence(messages: readonly ChatMessage[]): string[] {
  const seq: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const call of m.tool_calls) seq.push(call.name);
  }
  return seq;
}

/**
 * `required_tool_sequence` is checked as a *subsequence*, not a
 * contiguous prefix — extra tools may interleave. Returns true when
 * every required tool appears in the actual trajectory in order.
 */
function isSubsequence(needles: readonly string[], haystack: readonly string[]): boolean {
  let i = 0;
  for (const h of haystack) {
    if (i < needles.length && h === needles[i]) i += 1;
  }
  return i === needles.length;
}

export function scoreTrajectory(
  messages: readonly ChatMessage[],
  rubric: TrajectoryRubric,
): TrajectoryResult {
  const trajectory = extractToolCallSequence(messages);
  const count = trajectory.length;

  if (rubric.max_tool_calls != null && count > rubric.max_tool_calls) {
    return {
      passed: false,
      tool_call_count: count,
      trajectory,
      reason: `trajectory exceeded max_tool_calls: ${count} > ${rubric.max_tool_calls}`,
    };
  }

  if (rubric.forbidden_tools.length > 0) {
    const forbidden = new Set(rubric.forbidden_tools);
    const offending = trajectory.find((t) => forbidden.has(t));
    if (offending !== undefined) {
      return {
        passed: false,
        tool_call_count: count,
        trajectory,
        reason: `trajectory invoked forbidden tool: '${offending}'`,
      };
    }
  }

  if (rubric.required_tool_sequence.length > 0) {
    if (!isSubsequence(rubric.required_tool_sequence, trajectory)) {
      return {
        passed: false,
        tool_call_count: count,
        trajectory,
        reason: `trajectory missing required sequence: expected ${JSON.stringify(
          rubric.required_tool_sequence,
        )} as a subsequence of ${JSON.stringify(trajectory)}`,
      };
    }
  }

  return { passed: true, tool_call_count: count, trajectory };
}
