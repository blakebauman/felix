/**
 * `ConversationDO.getEvents` parses `from`/`to`/`limit` from query params.
 * `parseBound` is the sanitizer that keeps bare `Number(...)` garbage
 * (`NaN`, `Infinity`, negatives) and unbounded explicit limits from reaching
 * `sliceEvents`.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_EVENTS,
  MAX_STORED_EVENTS,
  parseBound,
  rollOffEvents,
} from '../../src/memory/conversation-do';
import type { SessionEvent } from '../../src/session/types';

function ev(seq: number, pinned = false): SessionEvent {
  return {
    seq,
    ts: seq,
    kind: 'message',
    role: 'user',
    content: `m${seq}`,
    ...(pinned ? { metadata: { pinned: true } } : {}),
  } as SessionEvent;
}

describe('parseBound', () => {
  it('returns null for a missing param', () => {
    expect(parseBound(null)).toBeNull();
  });

  it('returns null for non-numeric input', () => {
    expect(parseBound('abc')).toBeNull();
  });

  it('returns null for Infinity / NaN-producing input', () => {
    expect(parseBound('Infinity')).toBeNull();
    expect(parseBound('1e999')).toBeNull(); // overflows to Infinity
  });

  it('returns null for negative values', () => {
    expect(parseBound('-5')).toBeNull();
  });

  it('floors fractional values', () => {
    expect(parseBound('3.9')).toBe(3);
  });

  it('clamps an explicit over-cap limit to the ceiling', () => {
    expect(parseBound('999999999', MAX_EVENTS)).toBe(MAX_EVENTS);
  });

  it('passes a valid in-range value through', () => {
    expect(parseBound('42', MAX_EVENTS)).toBe(42);
  });
});

describe('rollOffEvents (stored-event ceiling)', () => {
  it('leaves a sub-ceiling log untouched', () => {
    const events = Array.from({ length: 10 }, (_, i) => ev(i));
    expect(rollOffEvents(events)).toBe(events);
  });

  it('drops the oldest events when over the ceiling, keeping seq order', () => {
    const events = Array.from({ length: MAX_STORED_EVENTS + 100 }, (_, i) => ev(i));
    const trimmed = rollOffEvents(events);
    expect(trimmed).toHaveLength(MAX_STORED_EVENTS);
    // Oldest 100 dropped; newest retained; still ascending by seq.
    expect(trimmed[0]!.seq).toBe(100);
    expect(trimmed[trimmed.length - 1]!.seq).toBe(MAX_STORED_EVENTS + 99);
    for (let i = 1; i < trimmed.length; i += 1) {
      expect(trimmed[i]!.seq).toBeGreaterThan(trimmed[i - 1]!.seq);
    }
  });

  it('preserves pinned anchors even when they are the oldest events', () => {
    const events = [
      ev(0, true), // pinned anchor, oldest
      ...Array.from({ length: MAX_STORED_EVENTS + 50 }, (_, i) => ev(i + 1)),
    ];
    const trimmed = rollOffEvents(events);
    expect(trimmed).toHaveLength(MAX_STORED_EVENTS);
    // The pinned anchor survived despite being the oldest.
    expect(trimmed.some((e) => e.seq === 0)).toBe(true);
  });
});
