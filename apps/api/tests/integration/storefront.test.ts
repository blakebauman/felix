/**
 * Per-brand serving + routing. Exercises the public /shop surface (config +
 * host/path resolution) and the core guarantee that a request served under a
 * brand context scopes the commerce tools to that brand's `brand_tenant`.
 *
 * The LLM chat round-trip isn't invoked (no live model in tests); instead we
 * prove the scoping primitive directly by running `catalog_search` inside
 * `runWithBrandContext` and asserting it returns the brand's catalog.
 */

import { env, SELF } from 'cloudflare:test';
import { upsertProduct } from '@felix/commerce/catalog-store';
import type { Product } from '@felix/commerce/models';
import { runWithBrandContext } from '@felix/commerce/storefront/context';
import { catalogSearchTool } from '@felix/commerce/tools';
import type { Env as AppEnv } from '@felix/harness/env';
import { _clearResolverCache } from '@felix/harness/manifests/resolver';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;
const JSON_HEADERS = { 'content-type': 'application/json' };

function product(tenant: string, id: string, title: string): Product {
  return {
    tenant_id: tenant,
    id,
    title,
    description: '',
    price_cents: 1000,
    currency: 'usd',
    image_url: '',
    category: 'general',
    inventory: 5,
    active: true,
    attrs: {},
    created_at: 1,
  };
}

async function provision(id: string, name: string) {
  return SELF.fetch('https://o.test/brands', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ id, name }),
  });
}

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
  await provision('shopco', 'Shop Co');
  // Catalog under the brand's data tenant + a decoy under `default`.
  await upsertProduct(testEnv, product('shopco', 'sc-widget', 'ShopCo Widget'));
  await upsertProduct(testEnv, product('default', 'default-thing', 'Default Thing'));
});

beforeEach(() => {
  _clearResolverCache();
});

describe('storefront config resolution', () => {
  it('serves brand config by path (storefront = brand_tenant)', async () => {
    const r = await SELF.fetch('https://o.test/shop/shopco/config');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { name: string; storefront: string };
    expect(body.name).toBe('Shop Co');
    expect(body.storefront).toBe('shopco');
  });

  it('404s an unknown storefront', async () => {
    const r = await SELF.fetch('https://o.test/shop/ghost/config');
    expect(r.status).toBe(404);
  });

  it('resolves a brand by registered Host header', async () => {
    const reg = await SELF.fetch('https://o.test/brands/shopco/domains', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ host: 'shop.shopco.com' }),
    });
    expect(reg.status).toBe(201);

    const r = await SELF.fetch('https://o.test/shop/config', {
      headers: { host: 'shop.shopco.com' },
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { storefront: string }).storefront).toBe('shopco');
  });

  it('404s a host with no storefront mapping', async () => {
    const r = await SELF.fetch('https://o.test/shop/config', { headers: { host: 'nope.example' } });
    expect(r.status).toBe(404);
  });
});

describe('brand-context scoping (core routing guarantee)', () => {
  it('runs commerce tools against the brand tenant, not the ambient default', async () => {
    const tool = catalogSearchTool();
    const raw = await runWithBrandContext(testEnv, undefined, 'shopco', undefined, () =>
      tool.executor.execute({}, {}),
    );
    const out = typeof raw === 'string' ? raw : raw.content;
    const products = JSON.parse(out) as Array<{ id: string }>;
    expect(products.map((p) => p.id)).toContain('sc-widget');
    expect(products.some((p) => p.id === 'default-thing')).toBe(false);
  });
});
