import { describe, expect, it } from 'vitest';
import { matchesAnyToolPattern, matchesToolPattern } from '../../src/tools/tool-match';

describe('matchesToolPattern', () => {
  it('matches an exact name', () => {
    expect(matchesToolPattern('stripe__create_charge', 'stripe__create_charge')).toBe(true);
    expect(matchesToolPattern('stripe__create_charge', 'stripe__refund')).toBe(false);
  });

  it('matches a trailing-* prefix (MCP-server gate)', () => {
    // The manifest controls `stripe` (the ref.name); the server can rename the
    // suffix but can't escape the prefix.
    expect(matchesToolPattern('stripe__create_charge', 'stripe__*')).toBe(true);
    expect(matchesToolPattern('stripe__evil_new_tool', 'stripe__*')).toBe(true);
    expect(matchesToolPattern('notion__create_page', 'stripe__*')).toBe(false);
  });

  it('matches a bare * (all tools)', () => {
    expect(matchesToolPattern('anything', '*')).toBe(true);
  });

  it('a plain prefix without * does not prefix-match', () => {
    expect(matchesToolPattern('stripe__create_charge', 'stripe__')).toBe(false);
  });

  it('matchesAnyToolPattern ORs the list', () => {
    expect(matchesAnyToolPattern('stripe__x', ['notion__*', 'stripe__*'])).toBe(true);
    expect(matchesAnyToolPattern('slack__x', ['notion__*', 'stripe__*'])).toBe(false);
  });
});
