/**
 * AEO surfaces: JSON-LD feed/product (with ratings + caching), sitemap.xml,
 * robots.txt, and the `.well-known/ai-catalog.json` discovery doc. Exercises
 * both path-resolved (`/structured/:storefront/...`) and host-resolved (custom
 * domain) routing, plus the ETag → 304 revalidation contract.
 */

import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertProduct } from '../../src/commerce/catalog-store';
import type { Product } from '../../src/commerce/models';
import type { Env as AppEnv } from '../../src/env';
import { _clearResolverCache } from '../../src/manifests/resolver';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;
const JSON_HEADERS = { 'content-type': 'application/json' };

function product(id: string, over: Partial<Product> = {}): Product {
  return {
    tenant_id: 'aeoco',
    id,
    title: `Item ${id}`,
    description: 'desc',
    price_cents: 2500,
    currency: 'usd',
    image_url: '',
    category: 'apparel',
    inventory: 10,
    active: true,
    attrs: {},
    created_at: 1700000000000,
    ...over,
  };
}

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
  await SELF.fetch('https://o.test/brands', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ id: 'aeoco', name: 'AEO Co' }),
  });
  await SELF.fetch('https://o.test/brands/aeoco/domains', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ host: 'shop.aeoco.com' }),
  });
  await upsertProduct(testEnv, product('tee-001', { attrs: { rating: 4.6, review_count: 42 } }));
  await upsertProduct(testEnv, product('mug-002'));
});

beforeEach(() => {
  _clearResolverCache();
});

describe('JSON-LD feed (path-resolved) + caching', () => {
  it('serves an ItemList with rating data and a weak ETag', async () => {
    const r = await SELF.fetch('https://o.test/structured/aeoco/feed.jsonld');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/ld+json');
    expect(r.headers.get('cache-control')).toContain('max-age');
    const etag = r.headers.get('etag');
    expect(etag).toMatch(/^W\//);

    const body = (await r.json()) as {
      '@type': string;
      itemListElement: Array<{ item: { aggregateRating?: { ratingValue: string } } }>;
    };
    expect(body['@type']).toBe('ItemList');
    const rated = body.itemListElement.find((e) => e.item.aggregateRating);
    expect(rated?.item.aggregateRating?.ratingValue).toBe('4.6');
  });

  it('returns 304 when the ETag matches', async () => {
    const first = await SELF.fetch('https://o.test/structured/aeoco/feed.jsonld');
    const etag = first.headers.get('etag') ?? '';
    const second = await SELF.fetch('https://o.test/structured/aeoco/feed.jsonld', {
      headers: { 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
  });
});

describe('product JSON-LD (@graph with breadcrumb)', () => {
  it('emits Product + BreadcrumbList with rating data', async () => {
    const r = await SELF.fetch('https://o.test/structured/aeoco/products/tee-001.jsonld');
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      '@graph': Array<{
        '@type': string;
        aggregateRating?: { ratingValue: string };
        itemListElement?: unknown[];
      }>;
    };
    const product = body['@graph'].find((n) => n['@type'] === 'Product');
    const crumbs = body['@graph'].find((n) => n['@type'] === 'BreadcrumbList');
    expect(product?.aggregateRating?.ratingValue).toBe('4.6');
    expect(crumbs?.itemListElement).toHaveLength(3); // Home → apparel → product
  });
});

describe('sitemap + robots (path-resolved)', () => {
  it('lists product URLs in the sitemap', async () => {
    const r = await SELF.fetch('https://o.test/structured/aeoco/sitemap.xml');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/xml');
    const xml = await r.text();
    expect(xml).toContain('<urlset');
    expect(xml).toContain('/products/tee-001');
    expect(xml).toContain('/products/mug-002');
  });

  it('welcomes AI crawlers in robots.txt and points at the sitemap', async () => {
    const r = await SELF.fetch('https://o.test/structured/aeoco/robots.txt');
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('User-agent: GPTBot');
    expect(body).toContain('Sitemap: https://o.test/structured/aeoco/sitemap.xml');
  });
});

describe('host-resolved crawler surfaces (root aliases)', () => {
  const host = { host: 'shop.aeoco.com' };

  it('serves /robots.txt for a registered brand domain', async () => {
    const r = await SELF.fetch('https://shop.aeoco.com/robots.txt', { headers: host });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('User-agent: PerplexityBot');
  });

  it('serves /sitemap.xml for a registered brand domain', async () => {
    const r = await SELF.fetch('https://shop.aeoco.com/sitemap.xml', { headers: host });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('/products/tee-001');
  });

  it('serves the .well-known discovery document', async () => {
    const r = await SELF.fetch('https://shop.aeoco.com/.well-known/ai-catalog.json', {
      headers: host,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { feed: string; product_template: string; brand: string };
    expect(body.brand).toBe('AEO Co');
    expect(body.feed).toContain('/structured/feed.jsonld');
    expect(body.product_template).toContain('{id}');
  });

  it('404s an unmapped host', async () => {
    const r = await SELF.fetch('https://nope.example/robots.txt', {
      headers: { host: 'nope.example' },
    });
    expect(r.status).toBe(404);
  });
});
