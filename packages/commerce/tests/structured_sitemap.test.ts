/**
 * sitemap.xml + robots.txt builders (pure).
 */

import { describe, expect, it } from 'vitest';
import type { Product } from '../src/models';
import { AI_CRAWLERS, robotsTxt } from '../src/structured/robots';
import { productsToSitemapXml, sitemapIndexXml } from '../src/structured/sitemap';

function product(over: Partial<Product> = {}): Product {
  return {
    tenant_id: 'acme',
    id: 'tee-001',
    title: 'Classic Tee',
    description: '',
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

describe('productsToSitemapXml', () => {
  it('emits a urlset with canonical, percent-encoded product locs', () => {
    const xml = productsToSitemapXml([product(), product({ id: 'mug/02' })], 'https://acme.test');
    expect(xml).toContain('<urlset');
    expect(xml).toContain('<loc>https://acme.test/products/tee-001</loc>');
    expect(xml).toContain('<loc>https://acme.test/products/mug%2F02</loc>');
    expect(xml).toContain('<lastmod>2023-11-14</lastmod>');
  });

  it('handles an empty catalog', () => {
    const xml = productsToSitemapXml([], 'https://acme.test');
    expect(xml).toContain('<urlset');
    expect(xml).not.toContain('<loc>');
  });
});

describe('sitemapIndexXml', () => {
  it('lists child sitemaps', () => {
    const xml = sitemapIndexXml(['https://acme.test/structured/a/sitemap.xml']);
    expect(xml).toContain('<sitemapindex');
    expect(xml).toContain('<loc>https://acme.test/structured/a/sitemap.xml</loc>');
  });
});

describe('robotsTxt', () => {
  it('welcomes AI crawlers and advertises the sitemap when enabled', () => {
    const body = robotsTxt({ allowAiCrawlers: true, sitemapUrl: 'https://acme.test/sitemap.xml' });
    for (const ua of AI_CRAWLERS) expect(body).toContain(`User-agent: ${ua}`);
    expect(body).toContain('User-agent: GPTBot\nAllow: /');
    expect(body).toContain('Sitemap: https://acme.test/sitemap.xml');
  });

  it('disallows AI crawlers when structured data is off', () => {
    const body = robotsTxt({ allowAiCrawlers: false });
    expect(body).toContain('User-agent: ClaudeBot\nDisallow: /');
    // Conventional crawlers stay allowed.
    expect(body).toContain('User-agent: *\nAllow: /');
  });
});
