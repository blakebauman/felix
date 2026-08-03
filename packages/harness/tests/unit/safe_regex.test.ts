import { describe, expect, it } from 'vitest';
import { compileSafeRegex, isSafeRegex, MAX_PATTERN_CHARS } from '../../src/security/safe-regex';

describe('compileSafeRegex', () => {
  it('compiles ordinary patterns', () => {
    expect(compileSafeRegex('\\brm\\b.*-rf', 'i').test('RM -rf /')).toBe(true);
    expect(compileSafeRegex('(drop|truncate)\\s+table', 'i').test('DROP TABLE x')).toBe(true);
    expect(compileSafeRegex('[a-z]+_[0-9]{2,4}').test('abc_123')).toBe(true);
  });

  it('rejects an empty or over-long pattern', () => {
    expect(() => compileSafeRegex('')).toThrow(/1-256 characters/);
    expect(() => compileSafeRegex('a'.repeat(MAX_PATTERN_CHARS + 1))).toThrow(/1-256 characters/);
  });

  it('rejects backreferences', () => {
    expect(() => compileSafeRegex('(a)\\1')).toThrow(/backreferences/);
    expect(() => compileSafeRegex('(?<x>a)\\k<x>')).toThrow(/backreferences/);
  });

  it('rejects lookarounds', () => {
    expect(() => compileSafeRegex('foo(?=bar)')).toThrow(/lookarounds/);
    expect(() => compileSafeRegex('foo(?!bar)')).toThrow(/lookarounds/);
    expect(() => compileSafeRegex('(?<=foo)bar')).toThrow(/lookarounds/);
  });

  it('rejects the nested-quantifier shapes that backtrack exponentially', () => {
    expect(() => compileSafeRegex('(a+)+$')).toThrow(/nested or ambiguous repetition/);
    expect(() => compileSafeRegex('(a|a)*$')).toThrow(/nested or ambiguous repetition/);
    expect(() => compileSafeRegex('(a*)*')).toThrow(/nested or ambiguous repetition/);
    expect(() => compileSafeRegex('a**')).toThrow(/nested or ambiguous repetition/);
  });

  it('allows a quantified non-capturing group without inner repetition', () => {
    expect(() => compileSafeRegex('(?:ab)+')).not.toThrow();
  });

  it('treats quantifier characters inside a character class as literals', () => {
    expect(() => compileSafeRegex('[*+{]')).not.toThrow();
    expect(() => compileSafeRegex('[a|b]+')).not.toThrow();
  });

  it('treats escaped quantifiers as literals', () => {
    expect(() => compileSafeRegex('\\(a\\+\\)\\+')).not.toThrow();
  });

  it('isSafeRegex mirrors compile without throwing', () => {
    expect(isSafeRegex('\\brm\\b')).toBe(true);
    expect(isSafeRegex('(a+)+$')).toBe(false);
    expect(isSafeRegex('')).toBe(false);
  });
});
