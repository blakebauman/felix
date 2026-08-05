/**
 * Tool-call pairing across session strategies.
 *
 * An assistant turn that calls a tool and the `tool` turn answering it are two
 * session events but one indivisible exchange to a provider: Anthropic rejects
 * a `tool_result` whose `tool_use` it can't see, OpenAI rejects a
 * `tool_call_id` that was never declared, and both are hard 400s rather than
 * degraded answers.
 *
 * Any strategy that renders a subset of the log can split that pair, and the
 * failure only appears once a real conversation outgrows the window — so this
 * asserts the invariant directly, over every strategy and every window size,
 * rather than trusting a few hand-picked cases.
 */

import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/patterns/types';
import { completeToolGroups, hasBrokenToolPairing } from '../../src/session/pairing';
import { getSessionStrategy } from '../../src/session/strategies';
import type { Session, SessionEvent } from '../../src/session/types';

/** A conversation that uses tools twice, so every window size is interesting. */
function toolConversation(): SessionEvent[] {
  return [
    { seq: 1, kind: 'message', role: 'user', content: 'do a thing' },
    {
      seq: 2,
      kind: 'message',
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', name: 'search', args: {} }],
    },
    { seq: 3, kind: 'tool_result', role: 'tool', content: 'results', tool_call_id: 'call_1' },
    { seq: 4, kind: 'message', role: 'assistant', content: 'here you go' },
    { seq: 5, kind: 'message', role: 'user', content: 'another' },
    {
      seq: 6,
      kind: 'message',
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_2', name: 'fetch', args: {} }],
    },
    { seq: 7, kind: 'tool_result', role: 'tool', content: 'more', tool_call_id: 'call_2' },
    { seq: 8, kind: 'message', role: 'assistant', content: 'done' },
  ] as SessionEvent[];
}

function sessionOf(events: SessionEvent[]): Session {
  return {
    async getEvents() {
      return events;
    },
    async append() {},
  } as unknown as Session;
}

/** Provider-level check over rendered messages, mirroring what the APIs enforce. */
function pairingProblems(messages: ChatMessage[]): string[] {
  const declared = new Set<string>();
  for (const m of messages) {
    for (const call of (m as { tool_calls?: Array<{ id: string }> }).tool_calls ?? []) {
      declared.add(call.id);
    }
  }
  const problems: string[] = [];
  for (const m of messages) {
    const id = (m as { tool_call_id?: string }).tool_call_id;
    if (m.role === 'tool' && id && !declared.has(id)) problems.push(`orphan result ${id}`);
  }
  return problems;
}

describe('completeToolGroups', () => {
  const all = toolConversation();

  it('pulls the declaring assistant back for an orphaned result', () => {
    const selected = [all[2] as SessionEvent]; // the tool_result alone
    const out = completeToolGroups(all, selected);
    expect(out.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('pulls results forward for a call whose answers were dropped', () => {
    const selected = [all[1] as SessionEvent]; // the assistant with tool_calls
    const out = completeToolGroups(all, selected);
    expect(out.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('never drops anything the strategy chose', () => {
    const selected = [all[0], all[6], all[7]] as SessionEvent[];
    const out = completeToolGroups(all, selected);
    for (const e of selected) expect(out).toContain(e);
  });

  it('returns events in seq order with no duplicates', () => {
    const out = completeToolGroups(all, [all[2], all[1], all[6]] as SessionEvent[]);
    const seqs = out.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('leaves a genuinely pending call alone', () => {
    // No result exists anywhere in the log — that is the log's own state, not
    // something the selection broke, and the resume path owns it.
    const pending = [
      { seq: 1, kind: 'message', role: 'user', content: 'go' },
      {
        seq: 2,
        kind: 'message',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'never_answered', name: 't', args: {} }],
      },
    ] as SessionEvent[];
    expect(completeToolGroups(pending, [pending[1] as SessionEvent]).map((e) => e.seq)).toEqual([
      2,
    ]);
  });

  it('is a no-op on an empty selection', () => {
    expect(completeToolGroups(all, [])).toEqual([]);
  });

  it('handles one assistant turn making several calls', () => {
    const multi = [
      {
        seq: 1,
        kind: 'message',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', name: 't', args: {} },
          { id: 'b', name: 't', args: {} },
        ],
      },
      { seq: 2, kind: 'tool_result', role: 'tool', content: 'ra', tool_call_id: 'a' },
      { seq: 3, kind: 'tool_result', role: 'tool', content: 'rb', tool_call_id: 'b' },
    ] as SessionEvent[];
    // Selecting one result must bring the call AND its sibling result, or the
    // provider sees a tool_use with only half its answers.
    expect(completeToolGroups(multi, [multi[2] as SessionEvent]).map((e) => e.seq)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('hasBrokenToolPairing', () => {
  it('detects an orphaned result', () => {
    const all = toolConversation();
    expect(hasBrokenToolPairing([all[2] as SessionEvent])).toBe(true);
  });

  it('accepts a complete exchange', () => {
    const all = toolConversation();
    expect(hasBrokenToolPairing([all[1], all[2]] as SessionEvent[])).toBe(false);
  });
});

describe('strategies never render half an exchange', () => {
  const events = toolConversation();
  const session = sessionOf(events);
  const incoming: ChatMessage[] = [{ role: 'user', content: 'next' }];

  // Every window size, so a boundary lands mid-exchange in several of them.
  const specs = [
    ...Array.from({ length: 9 }, (_, i) => `windowed:${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `summarizing:${i + 1}`),
    'full_replay',
  ];

  it.each(specs)('%s', async (spec) => {
    const rendered = await getSessionStrategy(spec).render(session, incoming, {
      systemPrompt: 'sys',
    });
    expect(pairingProblems(rendered)).toEqual([]);
  });

  it('windowed:2 previously split the second exchange', async () => {
    // The specific regression: slicing the last two events took the result and
    // left its call behind.
    const rendered = await getSessionStrategy('windowed:2').render(session, incoming, {
      systemPrompt: 'sys',
    });
    const roles = rendered.map((m) => m.role);
    expect(roles).toContain('tool');
    // The assistant that declared it now comes along.
    const declared = rendered.some((m) =>
      ((m as { tool_calls?: Array<{ id: string }> }).tool_calls ?? []).some(
        (c) => c.id === 'call_2',
      ),
    );
    expect(declared).toBe(true);
  });

  it('still bounds the window rather than rendering everything', async () => {
    const rendered = await getSessionStrategy('windowed:2').render(session, incoming, {
      systemPrompt: 'sys',
    });
    // Repair widens the window by the missing half, not to the whole log.
    expect(rendered.length).toBeLessThan(events.length + 2);
  });
});
