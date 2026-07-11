/**
 * `ConversationDO.getEvents` parses `from`/`to`/`limit` from query params.
 * `parseBound` is the sanitizer that keeps bare `Number(...)` garbage
 * (`NaN`, `Infinity`, negatives) and unbounded explicit limits from reaching
 * `sliceEvents`.
 */

import { describe, expect, it } from 'vitest';
import { MAX_EVENTS, parseBound } from '../../src/memory/conversation-do';

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
