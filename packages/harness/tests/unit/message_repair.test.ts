import { describe, expect, it } from 'vitest';
import { repairToolPairing } from '../../src/patterns/message-repair';
import type { ChatMessage } from '../../src/patterns/types';

function toolCall(id: string, name = 'search') {
  return { id, name, args: {} };
}

describe('repairToolPairing', () => {
  it('returns a well-formed array unchanged (same reference)', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [toolCall('a')] },
      { role: 'tool', content: 'result', tool_call_id: 'a', name: 'search' },
      { role: 'assistant', content: 'done' },
    ];
    const out = repairToolPairing(messages);
    expect(out).toBe(messages);
  });

  it('drops a dangling assistant tool_use with no matching result and empties the turn', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [toolCall('a')] },
    ];
    const out = repairToolPairing(messages);
    expect(out).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('drops only the dangling call and keeps assistant text when content remains', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'thinking out loud', tool_calls: [toolCall('a')] },
      { role: 'user', content: 'still there?' },
    ];
    const out = repairToolPairing(messages);
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'thinking out loud' },
      { role: 'user', content: 'still there?' },
    ]);
    // tool_calls key must be gone, not just empty.
    expect((out[1] as ChatMessage).tool_calls).toBeUndefined();
  });

  it('keeps matched calls while dropping unmatched ones on the same turn', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [toolCall('a'), toolCall('b')] },
      { role: 'tool', content: 'ra', tool_call_id: 'a' },
    ];
    const out = repairToolPairing(messages);
    expect(out[1]).toEqual({ role: 'assistant', content: '', tool_calls: [toolCall('a')] });
    expect(out).toHaveLength(3);
  });

  it('drops an orphan tool_result whose tool_use is absent', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'orphan', tool_call_id: 'gone' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'next' },
    ];
    const out = repairToolPairing(messages);
    expect(out).toEqual([
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'next' },
    ]);
  });

  it('de-duplicates tool_results, keeping the real result over the stub at the adjacent slot', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [toolCall('a')] },
      { role: 'tool', content: 'queued (stub)', tool_call_id: 'a' },
      { role: 'assistant', content: 'interim', tool_calls: [toolCall('b')] },
      { role: 'tool', content: 'rb', tool_call_id: 'b' },
      { role: 'assistant', content: 'more' },
      // The async queue consumer wrote the REAL result for `a` later.
      { role: 'tool', content: 'real result', tool_call_id: 'a' },
    ];
    const out = repairToolPairing(messages);
    // The kept `a` result stays adjacent to its assistant turn (index 2) but
    // carries the real content; the trailing duplicate is dropped.
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [toolCall('a')] },
      { role: 'tool', content: 'real result', tool_call_id: 'a' },
      { role: 'assistant', content: 'interim', tool_calls: [toolCall('b')] },
      { role: 'tool', content: 'rb', tool_call_id: 'b' },
      { role: 'assistant', content: 'more' },
    ]);
  });

  it('preserves the adjacency invariant: each kept tool_result immediately follows its call turn', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [toolCall('a')] },
      { role: 'tool', content: 'stub', tool_call_id: 'a' },
      { role: 'user', content: 'unrelated' },
      { role: 'tool', content: 'real', tool_call_id: 'a' },
    ];
    const out = repairToolPairing(messages);
    // Find every assistant turn with tool_calls; the very next message must be
    // a tool_result for one of those calls.
    for (let i = 0; i < out.length; i++) {
      const m = out[i]!;
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const ids = new Set(m.tool_calls.map((c) => c.id));
        const next = out[i + 1];
        expect(next?.role).toBe('tool');
        expect(ids.has(next!.tool_call_id!)).toBe(true);
      }
    }
    // Real content wins, positioned adjacent.
    expect(out[1]).toEqual({ role: 'tool', content: 'real', tool_call_id: 'a' });
    // No leftover duplicate/orphan tool messages.
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('drops a turn whose only calls are dangling but keeps thinking-bearing turns', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [toolCall('a')],
        thinking: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }],
      },
    ];
    const out = repairToolPairing(messages);
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        thinking: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }],
      },
    ]);
  });

  it('ignores a tool_result that precedes its call turn (out of order)', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: 'early', tool_call_id: 'a' },
      { role: 'assistant', content: '', tool_calls: [toolCall('a')] },
    ];
    const out = repairToolPairing(messages);
    // The early result is an orphan (no preceding call) and the call is
    // dangling (no following result) — both dropped.
    expect(out).toEqual([]);
  });
});
