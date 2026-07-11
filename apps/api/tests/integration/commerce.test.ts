/**
 * Commerce stores against miniflare D1 + the DO-backed session cart.
 *
 *   - catalog search is tenant-scoped and honours query/category/price filters
 *   - the Stripe webhook handler converts the session cart into a D1 order,
 *     recomputes/uses an authoritative total, and clears the cart
 */

import { env } from 'cloudflare:test';
import { readCart, writeCart } from '@felix/commerce/cart-session';
import { searchProducts, upsertProduct } from '@felix/commerce/catalog-store';
import type { Product } from '@felix/commerce/models';
import { getOrder } from '@felix/commerce/order-store';
import { handleCheckoutCompleted } from '@felix/commerce/webhook';
import type { Env as AppEnv } from '@felix/harness/env';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;

function product(tenant: string, id: string, over: Partial<Product> = {}): Product {
  return {
    tenant_id: tenant,
    id,
    title: over.title ?? `Product ${id}`,
    description: over.description ?? '',
    price_cents: over.price_cents ?? 1000,
    currency: 'usd',
    image_url: '',
    category: over.category ?? 'general',
    inventory: over.inventory ?? 10,
    active: over.active ?? true,
    attrs: {},
    created_at: 1,
  };
}

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
  await upsertProduct(
    testEnv,
    product('tenantA', 'tee', { title: 'Cotton Tee', category: 'apparel', price_cents: 2500 }),
  );
  await upsertProduct(
    testEnv,
    product('tenantA', 'mug', { title: 'Coffee Mug', category: 'home', price_cents: 1200 }),
  );
  await upsertProduct(
    testEnv,
    product('tenantB', 'secret', {
      title: 'Tenant B Only',
      category: 'apparel',
      price_cents: 9999,
    }),
  );
});

describe('catalog search', () => {
  it('only returns the calling tenant’s products', async () => {
    const a = await searchProducts(testEnv, 'tenantA', {});
    expect(a.map((p) => p.id).sort()).toEqual(['mug', 'tee']);
    expect(a.some((p) => p.id === 'secret')).toBe(false);

    const b = await searchProducts(testEnv, 'tenantB', {});
    expect(b.map((p) => p.id)).toEqual(['secret']);
  });

  it('filters by category and max price', async () => {
    const apparel = await searchProducts(testEnv, 'tenantA', { category: 'apparel' });
    expect(apparel.map((p) => p.id)).toEqual(['tee']);

    const cheap = await searchProducts(testEnv, 'tenantA', { maxPriceCents: 1500 });
    expect(cheap.map((p) => p.id)).toEqual(['mug']);
  });

  it('filters by free-text query', async () => {
    const found = await searchProducts(testEnv, 'tenantA', { query: 'coffee' });
    expect(found.map((p) => p.id)).toEqual(['mug']);
  });
});

describe('checkout → order conversion', () => {
  it('converts the session cart into a paid order and clears the cart', async () => {
    const threadId = 'tenantA:order-test';
    await writeCart(testEnv, threadId, {
      items: [
        { product_id: 'tee', title: 'Cotton Tee', qty: 2, price_cents: 2500 },
        { product_id: 'mug', title: 'Coffee Mug', qty: 1, price_cents: 1200 },
      ],
      currency: 'usd',
      updated_at: 1,
    });

    await handleCheckoutCompleted(testEnv, {
      id: 'cs_test_123',
      client_reference_id: threadId,
      amount_total: 6200, // 2*2500 + 1200
      currency: 'usd',
      metadata: { tenant_id: 'tenantA', thread_id: threadId },
    });

    // Find the order by scanning the tenant's orders for the stripe_ref.
    const row = await testEnv.DB.prepare(
      'SELECT id FROM orders WHERE tenant_id = ? AND stripe_ref = ?',
    )
      .bind('tenantA', 'cs_test_123')
      .first<{ id: string }>();
    expect(row).not.toBeNull();

    const order = await getOrder(testEnv, 'tenantA', row!.id);
    expect(order).not.toBeNull();
    expect(order!.status).toBe('paid');
    expect(order!.total_cents).toBe(6200);
    expect(order!.items).toHaveLength(2);

    // Cart cleared post-purchase.
    const cleared = await readCart(testEnv, threadId);
    expect(cleared.items).toHaveLength(0);
  });
});
