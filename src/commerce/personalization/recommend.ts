/**
 * Recommendation ranking (pure). Given the similar-product lists returned for
 * one or more seed products, merge them into a single ranked list: a candidate's
 * score is the sum of its similarity across seeds (co-occurrence boosts rank),
 * with seeds and any explicitly-excluded ids removed.
 *
 * Kept pure (no I/O) so it unit-tests without bindings — the tool layer supplies
 * the Vectorize results and the exclusion set.
 */

import type { SimilarProduct } from './embeddings';

export function rankRecommendations(
  perSeedResults: SimilarProduct[][],
  opts: { exclude: Iterable<string>; limit: number },
): string[] {
  const excluded = new Set(opts.exclude);
  const scores = new Map<string, number>();
  for (const list of perSeedResults) {
    for (const { product_id, score } of list) {
      if (!product_id || excluded.has(product_id)) continue;
      scores.set(product_id, (scores.get(product_id) ?? 0) + score);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, opts.limit))
    .map(([id]) => id);
}
