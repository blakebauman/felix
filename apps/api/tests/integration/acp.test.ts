/**
 * ACP merchant endpoints against miniflare. Drives the real router via
 * SELF.fetch with the test bearer key (vitest config sets ACP_API_KEY and
 * ACP_MERCHANT_TENANT='default'). Stripe is not configured in tests, so the
 * `complete` charge short-circuits to a decline — the order-creation path is
 * exercised directly via finalizeOrder.
 */

import { env, SELF } from 'cloudflare:test';
import { finalizeOrder } from '@felix/commerce/acp/checkout';
import type { AcpCheckoutSession } from '@felix/commerce/acp/models';
import { getProduct, upsertProduct } from '@felix/commerce/catalog-store';
import type { Product } from '@felix/commerce/models';
import { getOrder } from '@felix/commerce/order-store';
import type { Env as AppEnv } from '@felix/harness/env';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;
const AUTH = { authorization: 'Bearer test-acp-key', 'content-type': 'application/json' };

function product(id: string, over: Partial<Product> = {}): Product {
  return {
    tenant_id: 'default',
    id,
    title: over.title ?? id,
    description: over.description ?? `${id} desc`,
    price_cents: over.price_cents ?? 2500,
    currency: 'usd',
    image_url: '',
    category: over.category ?? 'apparel',
    inventory: over.inventory ?? 10,
    active: true,
    attrs: {},
    created_at: 1,
  };
}

const ADDRESS = {
  name: 'Ada Lovelace',
  line_one: '1 Analytical Engine Way',
  city: 'London',
  state: 'LDN',
  country: 'GB',
  postal_code: 'EC1A',
};

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
  await upsertProduct(testEnv, product('acp-tee', { title: 'ACP Tee', price_cents: 2500 }));
  await upsertProduct(testEnv, product('acp-mug', { title: 'ACP Mug', price_cents: 1200 }));
});

describe('ACP auth', () => {
  it('rejects missing/invalid API key', async () => {
    const r1 = await SELF.fetch('https://o.test/acp/feed');
    expect(r1.status).toBe(401);
    const r2 = await SELF.fetch('https://o.test/acp/feed', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(r2.status).toBe(401);
  });
});

describe('ACP product feed', () => {
  it('renders the catalog in ACP feed shape', async () => {
    const r = await SELF.fetch('https://o.test/acp/feed', { headers: AUTH });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { products: Array<Record<string, unknown>> };
    const tee = body.products.find((p) => p.item_id === 'acp-tee')!;
    expect(tee).toBeDefined();
    expect(tee.price).toBe('25.00 USD');
    expect(tee.availability).toBe('in_stock');
    expect(tee.is_eligible_checkout).toBe(true);
  });
});

describe('ACP checkout lifecycle', () => {
  it('create without address is not_ready; totals computed server-side', async () => {
    const r = await SELF.fetch('https://o.test/acp/checkout_sessions', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ items: [{ id: 'acp-tee', quantity: 2 }] }),
    });
    expect(r.status).toBe(201);
    const s = (await r.json()) as AcpCheckoutSession;
    expect(s.id).toMatch(/^acp_/);
    expect(s.status).toBe('not_ready_for_payment');
    expect(s.line_items[0]!.base_amount).toBe(5000);
    expect(s.totals.find((t) => t.type === 'subtotal')!.amount).toBe(5000);
  });

  it('create with address auto-selects shipping and is ready_for_payment', async () => {
    const r = await SELF.fetch('https://o.test/acp/checkout_sessions', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        items: [{ id: 'acp-mug', quantity: 1 }],
        fulfillment_address: ADDRESS,
      }),
    });
    const s = (await r.json()) as AcpCheckoutSession;
    expect(s.status).toBe('ready_for_payment');
    expect(s.fulfillment_option_id).toBe('standard');
    // 1200 item + 500 shipping
    expect(s.totals.find((t) => t.type === 'total')!.amount).toBe(1700);

    // retrieve round-trips
    const got = await SELF.fetch(`https://o.test/acp/checkout_sessions/${s.id}`, { headers: AUTH });
    expect(((await got.json()) as AcpCheckoutSession).id).toBe(s.id);
  });

  it('update adds an address and flips status to ready_for_payment', async () => {
    const created = await SELF.fetch('https://o.test/acp/checkout_sessions', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ items: [{ id: 'acp-tee', quantity: 1 }] }),
    });
    const s = (await created.json()) as AcpCheckoutSession;
    expect(s.status).toBe('not_ready_for_payment');

    const updated = await SELF.fetch(`https://o.test/acp/checkout_sessions/${s.id}`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ fulfillment_address: ADDRESS }),
    });
    const s2 = (await updated.json()) as AcpCheckoutSession;
    expect(s2.status).toBe('ready_for_payment');
    expect(s2.line_items).toHaveLength(1);
  });

  it('unknown product yields an error message and not_ready status', async () => {
    const r = await SELF.fetch('https://o.test/acp/checkout_sessions', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ items: [{ id: 'nope', quantity: 1 }], fulfillment_address: ADDRESS }),
    });
    const s = (await r.json()) as AcpCheckoutSession;
    expect(s.status).toBe('not_ready_for_payment');
    expect(s.messages.some((m) => m.type === 'error' && m.code === 'invalid')).toBe(true);
  });

  it('complete without a configured PSP returns a payment error, no order', async () => {
    const created = await SELF.fetch('https://o.test/acp/checkout_sessions', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        items: [{ id: 'acp-mug', quantity: 1 }],
        fulfillment_address: ADDRESS,
      }),
    });
    const s = (await created.json()) as AcpCheckoutSession;
    const done = await SELF.fetch(`https://o.test/acp/checkout_sessions/${s.id}/complete`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        payment_data: { token: 'spt_test', provider: 'stripe' },
      }),
    });
    const s2 = (await done.json()) as AcpCheckoutSession;
    expect(s2.status).not.toBe('completed');
    expect(s2.messages.some((m) => m.code === 'payment_declined')).toBe(true);
    expect(s2.order).toBeUndefined();
  });

  it('cancel flips status to canceled', async () => {
    const created = await SELF.fetch('https://o.test/acp/checkout_sessions', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ items: [{ id: 'acp-tee', quantity: 1 }] }),
    });
    const s = (await created.json()) as AcpCheckoutSession;
    const cancelled = await SELF.fetch(`https://o.test/acp/checkout_sessions/${s.id}/cancel`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(((await cancelled.json()) as AcpCheckoutSession).status).toBe('canceled');
  });
});

describe('ACP order finalization', () => {
  it('finalizeOrder writes a paid order from a completed session', async () => {
    const session: AcpCheckoutSession = {
      id: 'acp_finalize',
      status: 'ready_for_payment',
      currency: 'usd',
      line_items: [
        {
          id: 'li_acp-tee',
          item: { id: 'acp-tee', quantity: 2 },
          base_amount: 5000,
          discount: 0,
          subtotal: 5000,
          tax: 0,
          total: 5000,
        },
      ],
      fulfillment_options: [],
      totals: [{ type: 'total', display_text: 'Total', amount: 5500 }],
      messages: [],
      links: [],
    };
    const order = await finalizeOrder(
      testEnv,
      'default',
      session,
      'pi_test_123',
      1_700_000_000_000,
    );
    expect(order.checkout_session_id).toBe('acp_finalize');
    expect(order.permalink_url).toContain(order.id);

    const stored = await getOrder(testEnv, 'default', order.id);
    expect(stored!.status).toBe('paid');
    expect(stored!.total_cents).toBe(5500);
    expect(stored!.stripe_ref).toBe('pi_test_123');
  });

  it('finalizeOrder is idempotent per session — no duplicate order or double inventory decrement', async () => {
    await upsertProduct(testEnv, product('acp-idem', { title: 'Idem', inventory: 10 }));
    const session: AcpCheckoutSession = {
      id: 'acp_idem_session',
      status: 'ready_for_payment',
      currency: 'usd',
      line_items: [
        {
          id: 'li_acp-idem',
          item: { id: 'acp-idem', quantity: 3 },
          base_amount: 7500,
          discount: 0,
          subtotal: 7500,
          tax: 0,
          total: 7500,
        },
      ],
      fulfillment_options: [],
      totals: [{ type: 'total', display_text: 'Total', amount: 7500 }],
      messages: [],
      links: [],
    };

    // Simulate a retried / concurrent `complete`: finalize the same session twice.
    const first = await finalizeOrder(testEnv, 'default', session, 'pi_idem', 1_700_000_000_000);
    const second = await finalizeOrder(testEnv, 'default', session, 'pi_idem', 1_700_000_000_001);

    // Same deterministic order id both times — no duplicate order.
    expect(second.id).toBe(first.id);
    expect(first.id).toBe('acp_order_acp_idem_session');

    // Inventory dropped by exactly the quantity once (10 → 7), not twice.
    const after = await getProduct(testEnv, 'default', 'acp-idem');
    expect(after!.inventory).toBe(7);
  });
});
