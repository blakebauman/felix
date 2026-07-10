/**
 * SessionStrategy renders events from a session into the working-set
 * message array a pattern hands to the model. Pins the contract that:
 *
 *   1. `full_replay` produces `[system, ...history, ...incoming]` and
 *      drops `system`-role events from history (consistent with the
 *      legacy checkpointer which stripped them on append).
 *   2. `windowed:N` keeps the last N events.
 *   3. Unknown strategy spec falls back to full replay.
 *   4. Empty-id session (stateless caller) renders only the system prompt
 *      + incoming — no DO round-trip.
 */

import { describe, expect, it } from 'vitest';
import {
  fullReplaySessionStrategy,
  getSessionStrategy,
  makeWindowedSessionStrategy,
} from '../../../src/session/strategies';
import { analyzeWake, type Session, type SessionEvent } from '../../../src/session/types';

function staticSession(id: string, events: SessionEvent[]): Session {
  return {
    id,
    async getEvents() {
      return events.slice();
    },
    async head() {
      return { seq: events.length };
    },
    async append() {},
    async appendBatch() {},
    async reset() {},
    async wake() {
      return analyzeWake(events.slice());
    },
  };
}

const evMsg = (seq: number, role: SessionEvent['role'], content: string): SessionEvent => ({
  seq,
  ts: seq,
  kind: role === 'tool' ? 'tool_result' : 'message',
  role,
  content,
});

describe('FullReplaySessionStrategy', () => {
  it('renders [system, ...history, ...incoming] with system events stripped from history', async () => {
    const session = staticSession('t', [
      evMsg(0, 'system', 'stale system prompt that must be dropped'),
      evMsg(1, 'user', 'past user'),
      evMsg(2, 'assistant', 'past reply'),
    ]);
    const rendered = await fullReplaySessionStrategy.render(
      session,
      [{ role: 'user', content: 'now' }],
      { systemPrompt: 'sp' },
    );
    expect(rendered.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(rendered[0]!.content).toBe('sp');
    expect(rendered[1]!.content).toBe('past user');
    expect(rendered[3]!.content).toBe('now');
  });

  it('returns just [system, ...incoming] for an empty-id session', async () => {
    const session = staticSession('', []);
    const rendered = await fullReplaySessionStrategy.render(
      session,
      [{ role: 'user', content: 'hi' }],
      { systemPrompt: 'sp' },
    );
    expect(rendered.map((m) => m.role)).toEqual(['system', 'user']);
  });
});

describe('WindowedSessionStrategy', () => {
  it('keeps the last N events', async () => {
    const session = staticSession('t', [
      evMsg(0, 'user', 'turn-0'),
      evMsg(1, 'assistant', 'turn-1'),
      evMsg(2, 'user', 'turn-2'),
      evMsg(3, 'assistant', 'turn-3'),
    ]);
    const strategy = makeWindowedSessionStrategy(2);
    const rendered = await strategy.render(session, [{ role: 'user', content: 'now' }], {
      systemPrompt: 'sp',
    });
    expect(rendered.map((m) => m.content)).toEqual(['sp', 'turn-2', 'turn-3', 'now']);
  });

  it('treats N=0 as keeping no history (system + incoming only)', async () => {
    const session = staticSession('t', [evMsg(0, 'user', 'past')]);
    const strategy = makeWindowedSessionStrategy(0);
    const rendered = await strategy.render(session, [{ role: 'user', content: 'now' }], {
      systemPrompt: 'sp',
    });
    expect(rendered.map((m) => m.content)).toEqual(['sp', 'now']);
  });
});

describe('getSessionStrategy', () => {
  it('returns full_replay by default and on undefined/null/empty', async () => {
    const session = staticSession('t', [evMsg(0, 'user', 'past')]);
    for (const spec of [undefined, null, '', 'full_replay']) {
      const rendered = await getSessionStrategy(spec).render(
        session,
        [{ role: 'user', content: 'now' }],
        { systemPrompt: 'sp' },
      );
      expect(rendered).toHaveLength(3);
    }
  });

  it('parses windowed:N', async () => {
    const session = staticSession('t', [
      evMsg(0, 'user', 'a'),
      evMsg(1, 'user', 'b'),
      evMsg(2, 'user', 'c'),
    ]);
    const rendered = await getSessionStrategy('windowed:1').render(
      session,
      [{ role: 'user', content: 'd' }],
      { systemPrompt: 'sp' },
    );
    expect(rendered.map((m) => m.content)).toEqual(['sp', 'c', 'd']);
  });

  it('falls back to full_replay on a garbage spec', async () => {
    const session = staticSession('t', [evMsg(0, 'user', 'past')]);
    const rendered = await getSessionStrategy('not_a_strategy').render(
      session,
      [{ role: 'user', content: 'now' }],
      { systemPrompt: 'sp' },
    );
    expect(rendered).toHaveLength(3);
  });

  it('parses summarizing:N (falls back to windowed without a model)', async () => {
    const session = staticSession('t', [
      evMsg(0, 'user', 'old'),
      evMsg(1, 'assistant', 'keep-1'),
      evMsg(2, 'user', 'keep-2'),
    ]);
    // No `model` opt — strategy degrades to windowed semantics for the
    // keep window. This verifies the parser hooked up summarizing:N
    // without forcing the test to wire a real model client.
    const rendered = await getSessionStrategy('summarizing:2').render(
      session,
      [{ role: 'user', content: 'now' }],
      { systemPrompt: 'sp' },
    );
    expect(rendered.map((m) => m.content)).toEqual(['sp', 'keep-1', 'keep-2', 'now']);
  });

  it('falls back to full_replay on summarizing:0', async () => {
    const session = staticSession('t', [evMsg(0, 'user', 'past')]);
    const rendered = await getSessionStrategy('summarizing:0').render(
      session,
      [{ role: 'user', content: 'now' }],
      { systemPrompt: 'sp' },
    );
    // summarizing:0 fails the >0 guard and falls back to full_replay.
    expect(rendered).toHaveLength(3);
  });
});
