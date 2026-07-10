/**
 * `Session.wake()` is the resume primitive — read-only analysis of the
 * event log that tells a caller whether a paused or crashed run can
 * pick up. Pins:
 *
 *   1. fresh=true when there are no message events.
 *   2. endedOnAssistant=true when the last non-audit event is an
 *      assistant message without tool_calls — the prior run reached a
 *      clean stop.
 *   3. pendingToolCalls lists tool_calls from the most recent assistant
 *      turn that have no matching tool_result events after them.
 *   4. A tool_call cycle that completed (every call has a matching
 *      tool_result) leaves pendingToolCalls empty.
 *   5. audit events (e.g. session summaries) don't gate wake state.
 */

import { describe, expect, it } from 'vitest';
import { analyzeWake, type SessionEvent } from '../../../src/session/types';

function msg(
  seq: number,
  role: SessionEvent['role'],
  content: string,
  extras: Partial<SessionEvent> = {},
): SessionEvent {
  return {
    seq,
    ts: seq,
    kind: role === 'tool' ? 'tool_result' : 'message',
    role,
    content,
    ...extras,
  };
}

describe('analyzeWake', () => {
  it('returns fresh=true for an empty log', () => {
    expect(analyzeWake([])).toEqual({
      fresh: true,
      headSeq: 0,
      pendingToolCalls: [],
      endedOnAssistant: false,
    });
  });

  it('reports endedOnAssistant for a clean two-turn conversation', () => {
    const events = [msg(0, 'user', 'hi'), msg(1, 'assistant', 'hello')];
    const w = analyzeWake(events);
    expect(w.fresh).toBe(false);
    expect(w.headSeq).toBe(2);
    expect(w.endedOnAssistant).toBe(true);
    expect(w.pendingToolCalls).toEqual([]);
  });

  it('flags pending tool_calls when the assistant emitted calls and no tool_result followed', () => {
    const events = [
      msg(0, 'user', 'compute'),
      msg(1, 'assistant', '', {
        tool_calls: [{ id: 'tc1', name: 'calc', args: { expr: '2+2' } }],
      }),
    ];
    const w = analyzeWake(events);
    expect(w.pendingToolCalls).toEqual([{ id: 'tc1', name: 'calc', args: { expr: '2+2' } }]);
    expect(w.endedOnAssistant).toBe(false);
  });

  it('reports pending only the unresolved subset of a multi-call turn', () => {
    const events = [
      msg(0, 'user', 'do two things'),
      msg(1, 'assistant', '', {
        tool_calls: [
          { id: 'tc1', name: 'a', args: {} },
          { id: 'tc2', name: 'b', args: {} },
        ],
      }),
      // Only one of the two tool calls completed before the crash.
      msg(2, 'tool', 'a-result', { tool_call_id: 'tc1', name: 'a' }),
    ];
    const w = analyzeWake(events);
    expect(w.pendingToolCalls.map((c) => c.id)).toEqual(['tc2']);
  });

  it('empties pendingToolCalls when every call has a matching tool_result', () => {
    const events = [
      msg(0, 'user', 'go'),
      msg(1, 'assistant', '', {
        tool_calls: [{ id: 'tc1', name: 'a', args: {} }],
      }),
      msg(2, 'tool', 'a-result', { tool_call_id: 'tc1', name: 'a' }),
    ];
    const w = analyzeWake(events);
    expect(w.pendingToolCalls).toEqual([]);
    // Last non-audit event is tool_result, so endedOnAssistant is false.
    expect(w.endedOnAssistant).toBe(false);
  });

  it('reports endedOnAssistant after a fully-resolved tool cycle + assistant turn', () => {
    const events = [
      msg(0, 'user', 'go'),
      msg(1, 'assistant', '', { tool_calls: [{ id: 'tc1', name: 'a', args: {} }] }),
      msg(2, 'tool', 'a-result', { tool_call_id: 'tc1', name: 'a' }),
      msg(3, 'assistant', 'final answer'),
    ];
    const w = analyzeWake(events);
    expect(w.pendingToolCalls).toEqual([]);
    expect(w.endedOnAssistant).toBe(true);
  });

  it('ignores audit events when computing fresh/endedOnAssistant/pending', () => {
    // A summarizing strategy cached a session_summary audit event, plus
    // there's one real user turn — wake should not consider the audit
    // event when deciding fresh or endedOnAssistant.
    const events: SessionEvent[] = [
      {
        seq: 0,
        ts: 0,
        kind: 'audit',
        content: 'SUMMARY',
        metadata: { type: 'session_summary', covers_to_seq: -1 },
      },
      msg(1, 'user', 'hi'),
    ];
    const w = analyzeWake(events);
    expect(w.fresh).toBe(false);
    expect(w.headSeq).toBe(2);
    expect(w.endedOnAssistant).toBe(false);
    expect(w.pendingToolCalls).toEqual([]);
  });

  it('locates the most recent assistant-with-calls when earlier resolved cycles exist', () => {
    const events = [
      msg(0, 'user', 'first'),
      msg(1, 'assistant', '', { tool_calls: [{ id: 'old', name: 'a', args: {} }] }),
      msg(2, 'tool', 'r', { tool_call_id: 'old', name: 'a' }),
      msg(3, 'assistant', 'mid'),
      msg(4, 'user', 'second'),
      // New unresolved cycle.
      msg(5, 'assistant', '', { tool_calls: [{ id: 'new', name: 'b', args: {} }] }),
    ];
    const w = analyzeWake(events);
    expect(w.pendingToolCalls.map((c) => c.id)).toEqual(['new']);
  });
});
