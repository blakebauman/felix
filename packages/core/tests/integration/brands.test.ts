/**
 * D2C brand provisioning + catalog import end-to-end against miniflare.
 * Operator tenant resolves to `default` (anonymous; dev scope gate falls open).
 */

import { env, SELF } from 'cloudflare:test';
import type { Brand } from '@felix/commerce/brands/models';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env as AppEnv } from '../../src/env';
import { _clearResolverCache, resolveManifest } from '../../src/manifests/resolver';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;
const JSON_HEADERS = { 'content-type': 'application/json' };

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
});

beforeEach(() => {
  _clearResolverCache();
});

async function provision(id: string, name: string, identity?: Record<string, unknown>) {
  return SELF.fetch('https://o.test/brands', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ id, name, ...(identity ? { identity } : {}) }),
  });
}

describe('brand provisioning', () => {
  it('provisions a brand and writes a branded orderloop manifest under its tenant', async () => {
    const r = await provision('acme', 'Acme Co', {
      greeting: 'Welcome to Acme!',
      support_email: 'help@acme.test',
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { brand: Brand; manifest: { name: string; version: number } };
    expect(body.brand.brand_tenant).toBe('acme');
    expect(body.manifest.name).toBe('orderloop');

    // The branded manifest resolves under the brand's data tenant.
    const resolved = await resolveManifest(testEnv, 'acme', 'orderloop');
    expect(resolved.manifest.spec.system_prompt.inline).toContain('Acme Co');
    expect(resolved.manifest.spec.system_prompt.inline).toContain('Welcome to Acme!');
    // Inherits the base tool list (commerce tools).
    expect(resolved.manifest.spec.tools).toContain('commerce_checkout');
  });

  it('rejects a duplicate slug with 409', async () => {
    await provision('dup', 'Dup One');
    const again = await provision('dup', 'Dup Two');
    expect(again.status).toBe(409);
  });

  it('lists and fetches brands', async () => {
    await provision('listco', 'List Co');
    const list = await SELF.fetch('https://o.test/brands');
    const body = (await list.json()) as { brands: Brand[] };
    expect(body.brands.some((b) => b.id === 'listco')).toBe(true);

    const one = await SELF.fetch('https://o.test/brands/listco');
    expect(((await one.json()) as Brand).name).toBe('List Co');
  });
});

describe('catalog import', () => {
  it('imports plain JSON products into the brand tenant', async () => {
    await provision('jsonco', 'JSON Co');
    const r = await SELF.fetch('https://o.test/brands/jsonco/catalog', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        format: 'json',
        products: [
          { id: 'p1', title: 'Widget', price_cents: 1999, category: 'tools', inventory: 5 },
          { id: 'p2', title: 'Gadget', price_cents: 4999 },
        ],
      }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { imported: number }).imported).toBe(2);

    const cat = await SELF.fetch('https://o.test/brands/jsonco/catalog');
    const page = (await cat.json()) as { products: Array<{ id: string; price_cents: number }> };
    expect(page.products.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    expect(page.products.find((p) => p.id === 'p1')!.price_cents).toBe(1999);
  });

  it('imports the ACP feed shape, parsing the price string', async () => {
    await provision('feedco', 'Feed Co');
    const r = await SELF.fetch('https://o.test/brands/feedco/catalog', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        format: 'acp_feed',
        products: [
          { item_id: 'f1', title: 'Imported Tee', price: '25.00 USD', availability: 'in_stock' },
        ],
      }),
    });
    expect(((await r.json()) as { imported: number }).imported).toBe(1);

    const cat = await SELF.fetch('https://o.test/brands/feedco/catalog');
    const page = (await cat.json()) as {
      products: Array<{ id: string; price_cents: number; currency: string }>;
    };
    expect(page.products[0]!.price_cents).toBe(2500);
    expect(page.products[0]!.currency).toBe('usd');
  });

  it('404s importing into an unknown brand', async () => {
    const r = await SELF.fetch('https://o.test/brands/ghost/catalog', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ format: 'json', products: [{ id: 'x', title: 'x', price_cents: 1 }] }),
    });
    expect(r.status).toBe(404);
  });
});
