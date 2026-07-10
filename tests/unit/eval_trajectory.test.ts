/**
 * `scoreTrajectory` — tool-call-sequence gate.
 *
 * Pins:
 *   1. Empty trajectory rubric → always passes regardless of tool calls.
 *   2. `max_tool_calls` cap fires on the count overflowing.
 *   3. `forbidden_tools` fires when any forbidden name appears.
 *   4. `required_tool_sequence` checks for subsequence (extras may
 *      interleave).
 *   5. The trajectory itself (extracted tool names in order) is
 *      reported back even on a pass, so callers attach it to audit.
 */

import { describe, expect, it } from 'vitest';
import { extractToolCallSequence, scoreTrajectory } from '../../src/eval/trajectory';
import type { ChatMessage } from '../../src/patterns/types';

function tcMsg(...names: string[]): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: names.map((name, i) => ({ id: `tc-${i}`, name, args: {} })),
  };
}

const EMPTY_RUBRIC = {
  max_tool_calls: null,
  forbidden_tools: [],
  required_tool_sequence: [],
};

describe('extractToolCallSequence', () => {
  it('flattens tool_calls across assistant turns in invocation order', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'go' },
      tcMsg('search', 'summarize'),
      { role: 'tool', content: '...', tool_call_id: 'tc-0' },
      tcMsg('write'),
      { role: 'assistant', content: 'done' },
    ];
    expect(extractToolCallSequence(msgs)).toEqual(['search', 'summarize', 'write']);
  });

  it('returns empty when no assistant turn had tool_calls', () => {
    expect(
      extractToolCallSequence([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hi back' },
      ]),
    ).toEqual([]);
  });
});

describe('scoreTrajectory', () => {
  it('passes when rubric has no constraints', () => {
    const result = scoreTrajectory([tcMsg('a', 'b', 'c')], EMPTY_RUBRIC);
    expect(result.passed).toBe(true);
    expect(result.tool_call_count).toBe(3);
    expect(result.trajectory).toEqual(['a', 'b', 'c']);
  });

  it('fails when max_tool_calls is exceeded', () => {
    const result = scoreTrajectory([tcMsg('a', 'b', 'c')], {
      ...EMPTY_RUBRIC,
      max_tool_calls: 2,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/max_tool_calls: 3 > 2/);
  });

  it('passes exactly at the max_tool_calls limit', () => {
    const result = scoreTrajectory([tcMsg('a', 'b')], { ...EMPTY_RUBRIC, max_tool_calls: 2 });
    expect(result.passed).toBe(true);
  });

  it('fails when a forbidden tool is invoked', () => {
    const result = scoreTrajectory([tcMsg('search', 'memory_remember')], {
      ...EMPTY_RUBRIC,
      forbidden_tools: ['memory_remember'],
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/forbidden tool: 'memory_remember'/);
  });

  it('passes when required_tool_sequence is a subsequence of the actual trajectory', () => {
    const result = scoreTrajectory(
      // Actual: plan_create → search → plan_update_step → write
      [tcMsg('plan_create', 'search', 'plan_update_step', 'write')],
      { ...EMPTY_RUBRIC, required_tool_sequence: ['plan_create', 'plan_update_step'] },
    );
    expect(result.passed).toBe(true);
  });

  it('fails when required_tool_sequence is out of order', () => {
    const result = scoreTrajectory([tcMsg('write', 'plan_create', 'search')], {
      ...EMPTY_RUBRIC,
      required_tool_sequence: ['plan_create', 'write'],
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/missing required sequence/);
  });

  it('fails when a required tool is missing entirely', () => {
    const result = scoreTrajectory([tcMsg('search')], {
      ...EMPTY_RUBRIC,
      required_tool_sequence: ['plan_create'],
    });
    expect(result.passed).toBe(false);
  });
});
