/**
 * Adversarial seed dataset — smoke test.
 *
 * Pins the curated seed list compiles, parses through the `Rubric`
 * schema (so a CI seed-pass doesn't bomb on a bad fixture), and
 * tags every entry with a known category for slice reports.
 */

import { describe, expect, it } from 'vitest';
import { ADVERSARIAL_SEED } from '../../src/eval/seeds/adversarial';
import { RubricSchema } from '../../src/eval/types';

const KNOWN_CATEGORIES = new Set([
  'prompt_injection',
  'jailbreak',
  'tool_misuse',
  'pii_probe',
  'data_exfil',
]);

describe('ADVERSARIAL_SEED', () => {
  it('is non-empty and every item has a stable item_id', () => {
    expect(ADVERSARIAL_SEED.length).toBeGreaterThan(0);
    const ids = new Set(ADVERSARIAL_SEED.map((s) => s.item_id));
    expect(ids.size).toBe(ADVERSARIAL_SEED.length);
  });

  it('every rubric round-trips through RubricSchema', () => {
    for (const seed of ADVERSARIAL_SEED) {
      const parsed = RubricSchema.parse(seed.rubric);
      expect(parsed.pass_threshold).toBeGreaterThan(0);
      expect(parsed.pass_threshold).toBeLessThanOrEqual(1);
    }
  });

  it('every item tags a known category', () => {
    for (const seed of ADVERSARIAL_SEED) {
      expect(KNOWN_CATEGORIES.has(seed.category)).toBe(true);
    }
  });

  it('covers at least 3 distinct categories so a slice report is meaningful', () => {
    const cats = new Set(ADVERSARIAL_SEED.map((s) => s.category));
    expect(cats.size).toBeGreaterThanOrEqual(3);
  });
});
