/**
 * Recommendation ranking (pure).
 */

import { describe, expect, it } from 'vitest';
import type { SimilarProduct } from '../../src/commerce/personalization/embeddings';
import { rankRecommendations } from '../../src/commerce/personalization/recommend';

const s = (product_id: string, score: number): SimilarProduct => ({ product_id, score });

describe('rankRecommendations', () => {
  it('sums similarity across seeds so co-occurring items rank higher', () => {
    const ranked = rankRecommendations(
      [
        [s('a', 0.9), s('b', 0.5)],
        [s('b', 0.6), s('c', 0.8)],
      ],
      { exclude: [], limit: 3 },
    );
    // b appears in both seeds (0.5 + 0.6 = 1.1) → ranks first.
    expect(ranked).toEqual(['b', 'a', 'c']);
  });

  it('drops excluded ids (seeds + cart) and respects the limit', () => {
    const ranked = rankRecommendations([[s('a', 0.9), s('b', 0.5), s('c', 0.4)]], {
      exclude: ['a'],
      limit: 1,
    });
    expect(ranked).toEqual(['b']);
  });

  it('ignores empty product ids and returns [] when nothing remains', () => {
    const ranked = rankRecommendations([[s('', 0.9), s('a', 0.5)]], { exclude: ['a'], limit: 5 });
    expect(ranked).toEqual([]);
  });
});
