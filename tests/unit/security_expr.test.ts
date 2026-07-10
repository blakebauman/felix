import { describe, expect, it } from 'vitest';
import { evaluateExpression } from '../../src/security/expr';

describe('evaluateExpression', () => {
  it('handles basic arithmetic', () => {
    expect(evaluateExpression('1 + 2')).toBe(3);
    expect(evaluateExpression('2 * 3 + 4')).toBe(10);
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20);
  });

  it('respects operator precedence', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('10 - 2 * 3')).toBe(4);
  });

  it('handles unary minus', () => {
    expect(evaluateExpression('-3')).toBe(-3);
    expect(evaluateExpression('5 + -3')).toBe(2);
    expect(evaluateExpression('-(2 + 3)')).toBe(-5);
  });

  it('rejects non-arithmetic characters', () => {
    expect(() => evaluateExpression('1 + alert(1)')).toThrow(/invalid characters/);
    expect(() => evaluateExpression('process.exit(0)')).toThrow(/invalid characters/);
  });

  it('rejects malformed input', () => {
    expect(() => evaluateExpression('1 + ')).toThrow();
    expect(() => evaluateExpression('(1 + 2')).toThrow();
    expect(() => evaluateExpression('1 +)')).toThrow();
  });

  it('throws on division by zero', () => {
    expect(() => evaluateExpression('1 / 0')).toThrow(/division by zero/);
  });

  it('handles decimals', () => {
    expect(evaluateExpression('1.5 + 2.25')).toBeCloseTo(3.75);
  });
});
