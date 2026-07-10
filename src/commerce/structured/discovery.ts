/**
 * AI-catalog discovery document (pure). A single, stable `.well-known` pointer
 * that tells an answer engine where a brand's machine-readable surfaces live:
 * the JSON-LD ItemList feed, the per-product JSON-LD URL template, and the
 * sitemap. Analogous to the agent-card, but for the commerce catalog.
 */

import type { Brand } from '../brands/models';

export interface AiCatalogDiscovery {
  name: string;
  brand: string;
  /** JSON-LD ItemList of the catalog. */
  feed: string;
  /** Per-product JSON-LD; `{id}` is the SKU. */
  product_template: string;
  sitemap: string;
  format: 'application/ld+json';
  vocabulary: 'https://schema.org';
}

/**
 * @param feedUrl     absolute URL of the JSON-LD feed (ItemList)
 * @param sitemapUrl  absolute URL of the sitemap
 * @param productBase absolute base for product JSON-LD (id appended)
 */
export function aiCatalog(
  brand: Brand,
  feedUrl: string,
  sitemapUrl: string,
  productBase: string,
): AiCatalogDiscovery {
  return {
    name: 'ai-catalog',
    brand: brand.name,
    feed: feedUrl,
    product_template: `${productBase}/{id}.jsonld`,
    sitemap: sitemapUrl,
    format: 'application/ld+json',
    vocabulary: 'https://schema.org',
  };
}
