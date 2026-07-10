/**
 * Hardening: inventory decrement on order (both checkout sides), catalog
 * pagination, and the ACP feed pagination route. Uses an isolated tenant
 * where possible so counts are deterministic regardless of other suites.
 */

import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { writeCart } from '../../src/commerce/cart-session';
import {
  decrementInventory,
  getProduct,
  listProductsPage,
  upsertProduct,
} from '../../src/commerce/catalog-store';
import type { Product } from '../../src/commerce/models';
import { handleCheckoutCompleted } from '../../src/commerce/webhook';
import type { Env as AppEnv } from '../../src/env';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;

function product(tenant: string, id: string, inventory: number): Product {
  return {
    tenant_id: tenant,
    id,
    title: id,
    description: '',
    price_cents: 1000,
    currency: 'usd',
    image_url: '',
    category: 'general',
    inventory,
    active: true,
    attrs: {},
    created_at: 1,
  };
}

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
  await upsertProduct(testEnv, product('harden', 'h-a', 10));
  await upsertProduct(testEnv, product('harden', 'h-b', -1)); // unlimited
  for (let i = 0; i < 5; i += 1) {
    await upsertProduct(testEnv, product('harden', `page-${i}`, 3));
  }
  // Merchant tenant for the ACP feed route (ACP_MERCHANT_TENANT='default').
  await upsertProduct(testEnv, product('default', 'feed-seed', 5));
});

describe('inventory decrement', () => {
  it('decrements finite stock, clamps at 0, and skips unlimited (-1)', async () => {
    await decrementInventory(testEnv, 'harden', [
      { id: 'h-a', qty: 3 },
      { id: 'h-b', qty: 99 },
    ]);
    expect((await getProduct(testEnv, 'harden', 'h-a'))!.inventory).toBe(7);
    expect((await getProduct(testEnv, 'harden', 'h-b'))!.inventory).toBe(-1);

    await decrementInventory(testEnv, 'harden', [{ id: 'h-a', qty: 100 }]);
    expect((await getProduct(testEnv, 'harden', 'h-a'))!.inventory).toBe(0); // clamped
  });

  it('buyer-side checkout completion decrements inventory', async () => {
    await upsertProduct(testEnv, product('harden', 'h-buy', 5));
    const threadId = 'harden:buy-thread';
    await writeCart(testEnv, threadId, {
      items: [{ product_id: 'h-buy', title: 'h-buy', qty: 2, price_cents: 1000 }],
      currency: 'usd',
      updated_at: 1,
    });
    await handleCheckoutCompleted(testEnv, {
      id: 'cs_harden_1',
      client_reference_id: threadId,
      amount_total: 2000,
      currency: 'usd',
      metadata: { tenant_id: 'harden', thread_id: threadId },
    });
    expect((await getProduct(testEnv, 'harden', 'h-buy'))!.inventory).toBe(3);
  });
});

describe('catalog pagination', () => {
  it('pages by stable id order with has_more', async () => {
    const page1 = await listProductsPage(testEnv, 'harden', { limit: 2, offset: 0 });
    expect(page1.products).toHaveLength(2);
    expect(page1.has_more).toBe(true);

    const page2 = await listProductsPage(testEnv, 'harden', { limit: 2, offset: 2 });
    // Disjoint from page 1.
    const ids1 = page1.products.map((p) => p.id);
    expect(page2.products.every((p) => !ids1.includes(p.id))).toBe(true);
  });
});

describe('ACP feed pagination route', () => {
  it('respects limit and echoes paging metadata', async () => {
    const r = await SELF.fetch('https://o.test/acp/feed?limit=1&offset=0', {
      headers: { authorization: 'Bearer test-acp-key' },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      products: unknown[];
      has_more: boolean;
      limit: number;
      offset: number;
    };
    expect(body.products).toHaveLength(1);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(0);
  });
});
