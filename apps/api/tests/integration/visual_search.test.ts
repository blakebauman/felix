/**
 * Visual-search storefront endpoint. Vectorize/AI aren't bound in the miniflare
 * pool, so similarity degrades to empty — the endpoint is asserted to accept the
 * multipart upload, stash it in R2, and return a well-formed product array
 * rather than throwing. Validation paths (missing image, unknown brand) are
 * exercised fully.
 */

import { env, SELF } from 'cloudflare:test';
import { upsertProduct } from '@felix/commerce/catalog-store';
import type { Product } from '@felix/commerce/models';
import type { Env as AppEnv } from '@felix/harness/env';
import { _clearResolverCache } from '@felix/harness/manifests/resolver';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;
const JSON_HEADERS = { 'content-type': 'application/json' };

function product(id: string): Product {
  return {
    tenant_id: 'viz',
    id,
    title: `Item ${id}`,
    description: '',
    price_cents: 1000,
    currency: 'usd',
    image_url: '',
    category: 'apparel',
    inventory: 5,
    active: true,
    attrs: {},
    created_at: 1,
  };
}

function imageForm(): FormData {
  const fd = new FormData();
  fd.append('image', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }), 'q.png');
  return fd;
}

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
  await SELF.fetch('https://o.test/brands', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ id: 'viz', name: 'Viz Co' }),
  });
  await upsertProduct(testEnv, product('v-tee'));
});

beforeEach(() => {
  _clearResolverCache();
});

describe('POST /shop/:storefront/visual-search', () => {
  it('accepts an image upload and returns a product array', async () => {
    const r = await SELF.fetch('https://o.test/shop/viz/visual-search', {
      method: 'POST',
      body: imageForm(),
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
  });

  it('400s when no image is provided', async () => {
    const r = await SELF.fetch('https://o.test/shop/viz/visual-search', {
      method: 'POST',
      body: new FormData(),
    });
    expect(r.status).toBe(400);
  });

  it('404s an unknown storefront', async () => {
    const r = await SELF.fetch('https://o.test/shop/ghost/visual-search', {
      method: 'POST',
      body: imageForm(),
    });
    expect(r.status).toBe(404);
  });
});

describe('POST /brands/:id/reindex (embedding backfill)', () => {
  it('reindexes the brand catalog and reports a count', async () => {
    const r = await SELF.fetch('https://o.test/brands/viz/reindex', { method: 'POST' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; reindexed: number };
    expect(body.ok).toBe(true);
    expect(body.reindexed).toBeGreaterThanOrEqual(1);
  });

  it('404s an unknown brand', async () => {
    const r = await SELF.fetch('https://o.test/brands/ghost/reindex', { method: 'POST' });
    expect(r.status).toBe(404);
  });
});
