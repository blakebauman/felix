/**
 * Volume-tier selection (pure).
 */

import { describe, expect, it } from 'vitest';
import { effectiveTierPrice } from '../src/b2b/pricing-models';

const tiers = [
  { min_qty: 1, unit_price_cents: 1000 },
  { min_qty: 10, unit_price_cents: 800 },
  { min_qty: 50, unit_price_cents: 600 },
];

describe('effectiveTierPrice', () => {
  it('picks the highest applicable tier for the quantity', () => {
    expect(effectiveTierPrice(tiers, 1)).toBe(1000);
    expect(effectiveTierPrice(tiers, 9)).toBe(1000);
    expect(effectiveTierPrice(tiers, 10)).toBe(800);
    expect(effectiveTierPrice(tiers, 49)).toBe(800);
    expect(effectiveTierPrice(tiers, 100)).toBe(600);
  });
  it('returns null when no tier applies (qty below the first break)', () => {
    expect(effectiveTierPrice([{ min_qty: 5, unit_price_cents: 100 }], 4)).toBeNull();
  });
  it('returns null for empty tiers', () => {
    expect(effectiveTierPrice([], 10)).toBeNull();
  });
});
