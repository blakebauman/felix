/**
 * Account/contract pricing flows through quote pricing: contract volume tiers,
 * account-level discount, manual override precedence, and pricing CRUD.
 */

import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { upsertProduct } from '../../src/commerce/catalog-store';
import '../../src/commerce/b2b/store';
import '../../src/commerce/b2b/quote-store';
import type { ContractPrice } from '../../src/commerce/b2b/pricing-models';
import type { Quote } from '../../src/commerce/b2b/quote-models';
import type { Product } from '../../src/commerce/models';
import type { Env as AppEnv } from '../../src/env';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;
const H = { 'content-type': 'application/json' };

function product(id: string, price: number): Product {
  return {
    tenant_id: 'default',
    id,
    title: id,
    description: '',
    price_cents: price,
    currency: 'usd',
    image_url: '',
    category: '',
    inventory: 1000,
    active: true,
    attrs: {},
    created_at: 1,
  };
}

async function post(path: string, body?: unknown) {
  return SELF.fetch(`https://o.test${path}`, {
    method: 'POST',
    headers: H,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function quoteTotal(account: string, items: unknown): Promise<number> {
  const r = await post('/b2b/quotes', { account_id: account, buyer_id: `${account}-b`, items });
  return ((await r.json()) as Quote).total_cents;
}

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
  await upsertProduct(testEnv, product('gear', 1000));
  // Plain account (contract pricing), and a discounted account.
  await post('/b2b/accounts', { id: 'priceco', name: 'Price Co' });
  await post('/b2b/accounts/priceco/buyers', { id: 'priceco-b' });
  await post('/b2b/accounts', { id: 'discco', name: 'Disc Co', metadata: { discount_bps: 1000 } });
  await post('/b2b/accounts/discco/buyers', { id: 'discco-b' });
});

describe('contract volume-tier pricing in quotes', () => {
  beforeAll(async () => {
    await SELF.fetch('https://o.test/b2b/accounts/priceco/pricing/gear', {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({
        tiers: [
          { min_qty: 1, unit_price_cents: 900 },
          { min_qty: 10, unit_price_cents: 700 },
        ],
      }),
    });
  });

  it('applies the tier price for the line quantity', async () => {
    expect(await quoteTotal('priceco', [{ product_id: 'gear', qty: 1 }])).toBe(900);
    expect(await quoteTotal('priceco', [{ product_id: 'gear', qty: 10 }])).toBe(7000); // 10 * 700
  });

  it('a manual per-line override beats the contract price', async () => {
    expect(
      await quoteTotal('priceco', [{ product_id: 'gear', qty: 1, unit_price_cents: 500 }]),
    ).toBe(500);
  });
});

describe('account-level discount (no contract price)', () => {
  it('applies discount_bps off the catalog price', async () => {
    // catalog 1000, 10% off → 900
    expect(await quoteTotal('discco', [{ product_id: 'gear', qty: 1 }])).toBe(900);
  });
});

describe('pricing CRUD', () => {
  it('set → list → delete a contract price', async () => {
    const set = await SELF.fetch('https://o.test/b2b/accounts/priceco/pricing/gear', {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ tiers: [{ min_qty: 1, unit_price_cents: 850 }] }),
    });
    expect(set.status).toBe(200);

    const list = await SELF.fetch('https://o.test/b2b/accounts/priceco/pricing');
    const prices = ((await list.json()) as { prices: ContractPrice[] }).prices;
    expect(prices.find((p) => p.product_id === 'gear')?.tiers[0]?.unit_price_cents).toBe(850);

    const del = await SELF.fetch('https://o.test/b2b/accounts/priceco/pricing/gear', {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);

    // After delete, the quote falls back to the catalog price.
    expect(await quoteTotal('priceco', [{ product_id: 'gear', qty: 1 }])).toBe(1000);
  });
});
