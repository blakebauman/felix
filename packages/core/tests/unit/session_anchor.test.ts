/**
 * Anchor messages. Events tagged `metadata.pinned: true`
 * survive compaction in every strategy.
 */

import { describe, expect, it } from 'vitest';
import { isPinned, makeWindowedSessionStrategy } from '../../src/session/strategies';
import type { Session, SessionEvent } from '../../src/session/types';

function ev(
  seq: number,
  role: 'user' | 'assistant',
  content: string,
  pinned = false,
): SessionEvent {
  return {
    seq,
    ts: 0,
    kind: 'message',
    role,
    content,
    ...(pinned ? { metadata: { pinned: true } } : {}),
  };
}

function fakeSession(events: SessionEvent[]): Session {
  return {
    id: 'thr',
    async getEvents() {
      return events;
    },
    async head() {
      return { seq: events.length };
    },
    async append() {},
    async appendBatch() {},
    async reset() {},
    async wake() {
      return {
        fresh: false,
        headSeq: events.length,
        pendingToolCalls: [],
        endedOnAssistant: false,
      };
    },
  };
}

describe('isPinned', () => {
  it('returns true when metadata.pinned is true', () => {
    expect(isPinned(ev(0, 'user', 'x', true))).toBe(true);
  });

  it('returns false when metadata is absent or pinned is missing', () => {
    expect(isPinned(ev(0, 'user', 'x'))).toBe(false);
    expect(isPinned({ ...ev(0, 'user', 'x'), metadata: {} })).toBe(false);
    expect(isPinned({ ...ev(0, 'user', 'x'), metadata: { pinned: false } })).toBe(false);
  });
});

describe('windowed strategy + pinned events', () => {
  it('keeps pinned events alongside the last-N window', async () => {
    const strategy = makeWindowedSessionStrategy(2);
    const events = [
      ev(0, 'user', 'mission: stay on topic', true),
      ev(1, 'user', 'first turn'),
      ev(2, 'assistant', 'first reply'),
      ev(3, 'user', 'second turn'),
      ev(4, 'assistant', 'second reply'),
      ev(5, 'user', 'third turn'),
      ev(6, 'assistant', 'third reply'),
    ];
    const rendered = await strategy.render(fakeSession(events), [], { systemPrompt: 'sp' });
    // Expect: system + pinned + last 2 unpinned + (no incoming)
    expect(rendered[0]).toMatchObject({ role: 'system', content: 'sp' });
    expect(rendered.slice(1).map((m) => m.content)).toEqual([
      'mission: stay on topic',
      'third turn',
      'third reply',
    ]);
  });

  it('renders pinned events in seq order even when newer non-pinned exist', async () => {
    const strategy = makeWindowedSessionStrategy(1);
    const events = [
      ev(0, 'user', 'first turn'),
      ev(1, 'user', 'mission pinned', true),
      ev(2, 'user', 'second turn'),
      ev(3, 'assistant', 'last turn'),
    ];
    const rendered = await strategy.render(fakeSession(events), [], { systemPrompt: 'sp' });
    // pinned-at-seq-1 is rendered between the system message and the
    // tail-1 window (only `last turn` qualifies).
    expect(rendered.slice(1).map((m) => m.content)).toEqual(['mission pinned', 'last turn']);
  });
});
