/**
 * UCP merchant endpoints against miniflare. Drives the real router via
 * SELF.fetch with the test bearer key (vitest config sets UCP_API_KEY and
 * UCP_MERCHANT_TENANT='default'). Stripe is not configured in tests, so the
 * `complete` charge short-circuits to a decline — the order-creation path is
 * exercised directly via finalizeUcpOrder.
 */

import { env, SELF } from 'cloudflare:test';
import { getProduct, upsertProduct } from '@felix/commerce/catalog-store';
import type { Product } from '@felix/commerce/models';
import { getOrder } from '@felix/commerce/order-store';
import { finalizeUcpOrder } from '@felix/commerce/ucp/checkout';
import { UCP_VERSION, type UcpCheckoutSession } from '@felix/commerce/ucp/models';
import type { Env as AppEnv } from '@felix/harness/env';
import { beforeAll, describe, expect, it } from 'vitest';

const testEnv = env as unknown as AppEnv;
const AUTH = { authorization: 'Bearer test-ucp-key', 'content-type': 'application/json' };

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

const DESTINATION = {
  full_name: 'Ada Lovelace',
  street_address: '1 Analytical Engine Way',
  address_locality: 'London',
  address_region: 'LDN',
  address_country: 'GB',
  postal_code: 'EC1A',
};

/** Request fulfillment block carrying the single shipping destination. */
const FULFILLMENT = { methods: [{ type: 'shipping', destinations: [DESTINATION] }] };

function create(body: Record<string, unknown>) {
  return SELF.fetch('https://o.test/ucp/checkout-sessions', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await upsertProduct(testEnv, product('ucp-tee', { title: 'UCP Tee', price_cents: 2500 }));
  await upsertProduct(testEnv, product('ucp-mug', { title: 'UCP Mug', price_cents: 1200 }));
});

describe('UCP auth + versioning', () => {
  it('rejects missing/invalid API key', async () => {
    const r1 = await SELF.fetch('https://o.test/ucp/checkout-sessions/nope');
    expect(r1.status).toBe(401);
    const r2 = await SELF.fetch('https://o.test/ucp/checkout-sessions/nope', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(r2.status).toBe(401);
  });

  it('rejects a UCP-Agent speaking a newer spec version', async () => {
    const r = await SELF.fetch('https://o.test/ucp/checkout-sessions/nope', {
      headers: { ...AUTH, 'UCP-Agent': 'TestAgent/1.0 version="9999-01-01"' },
    });
    expect(r.status).toBe(400);
  });
});

describe('UCP discovery', () => {
  it('serves the merchant profile at /.well-known/ucp without auth', async () => {
    const r = await SELF.fetch('https://o.test/.well-known/ucp');
    expect(r.status).toBe(200);
    const profile = (await r.json()) as {
      ucp: {
        version: string;
        services: Record<string, { rest: { endpoint: string } }>;
        capabilities: Array<{ name: string }>;
      };
      payment: { handlers: Array<{ id: string }> };
    };
    expect(profile.ucp.version).toBe(UCP_VERSION);
    expect(profile.ucp.services['dev.ucp.shopping']!.rest.endpoint).toBe('https://o.test/ucp');
    expect(profile.ucp.capabilities.some((c) => c.name === 'dev.ucp.shopping.checkout')).toBe(true);
    expect(profile.payment.handlers.length).toBeGreaterThan(0);
  });
});

describe('UCP checkout lifecycle', () => {
  it('create without destination is incomplete; totals computed server-side', async () => {
    const r = await create({ line_items: [{ item: { id: 'ucp-tee' }, quantity: 2 }] });
    expect(r.status).toBe(201);
    const s = (await r.json()) as UcpCheckoutSession;
    expect(s.id).toMatch(/^ucp_/);
    expect(s.status).toBe('incomplete');
    expect(s.line_items[0]!.item.price).toBe(2500);
    expect(s.line_items[0]!.totals.find((t) => t.type === 'subtotal')!.amount).toBe(5000);
    expect(s.totals.find((t) => t.type === 'subtotal')!.amount).toBe(5000);
    expect(s.ucp.version).toBe(UCP_VERSION);
  });

  it('create with destination auto-selects shipping and is ready_for_complete', async () => {
    const r = await create({
      line_items: [{ item: { id: 'ucp-mug' }, quantity: 1 }],
      fulfillment: FULFILLMENT,
    });
    const s = (await r.json()) as UcpCheckoutSession;
    expect(s.status).toBe('ready_for_complete');

    const method = s.fulfillment!.methods!.find((m) => m.type === 'shipping')!;
    expect(method.selected_destination_id).toBe('dest_1');
    const group = method.groups![0]!;
    expect(group.options.length).toBeGreaterThan(0);
    expect(group.selected_option_id).toBe('standard');

    // 1200 item + 500 shipping; Σ non-total totals == total (spec invariant).
    const total = s.totals.find((t) => t.type === 'total')!.amount;
    expect(total).toBe(1700);
    const sumOfParts = s.totals
      .filter((t) => t.type !== 'total')
      .reduce((sum, t) => sum + t.amount, 0);
    expect(sumOfParts).toBe(total);

    // retrieve round-trips
    const got = await SELF.fetch(`https://o.test/ucp/checkout-sessions/${s.id}`, { headers: AUTH });
    expect(((await got.json()) as UcpCheckoutSession).id).toBe(s.id);
  });

  it('PUT update adds a destination and flips status to ready_for_complete', async () => {
    const created = await create({ line_items: [{ item: { id: 'ucp-tee' }, quantity: 1 }] });
    const s = (await created.json()) as UcpCheckoutSession;
    expect(s.status).toBe('incomplete');

    const updated = await SELF.fetch(`https://o.test/ucp/checkout-sessions/${s.id}`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ fulfillment: FULFILLMENT }),
    });
    const s2 = (await updated.json()) as UcpCheckoutSession;
    expect(s2.status).toBe('ready_for_complete');
    expect(s2.line_items).toHaveLength(1);
  });

  it('unknown product yields an error message and incomplete status', async () => {
    const r = await create({
      line_items: [{ item: { id: 'nope' }, quantity: 1 }],
      fulfillment: FULFILLMENT,
    });
    const s = (await r.json()) as UcpCheckoutSession;
    expect(s.status).toBe('incomplete');
    expect(s.messages.some((m) => m.type === 'error' && m.code === 'invalid')).toBe(true);
  });

  it('complete without a configured PSP returns a payment error, no order', async () => {
    const created = await create({
      line_items: [{ item: { id: 'ucp-mug' }, quantity: 1 }],
      fulfillment: FULFILLMENT,
    });
    const s = (await created.json()) as UcpCheckoutSession;
    const done = await SELF.fetch(`https://o.test/ucp/checkout-sessions/${s.id}/complete`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        payment_data: {
          handler_id: 'stripe',
          type: 'card',
          credential: { type: 'token', token: 'tok_test' },
        },
      }),
    });
    const s2 = (await done.json()) as UcpCheckoutSession;
    expect(s2.status).not.toBe('completed');
    expect(s2.messages.some((m) => m.code === 'payment_declined')).toBe(true);
    expect(s2.order_id).toBeUndefined();
  });

  it('complete without a credential token is a 400', async () => {
    const created = await create({
      line_items: [{ item: { id: 'ucp-mug' }, quantity: 1 }],
      fulfillment: FULFILLMENT,
    });
    const s = (await created.json()) as UcpCheckoutSession;
    const done = await SELF.fetch(`https://o.test/ucp/checkout-sessions/${s.id}/complete`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ payment_data: { handler_id: 'stripe' } }),
    });
    expect(done.status).toBe(400);
  });

  it('cancel flips status to canceled; further update/complete conflict', async () => {
    const created = await create({ line_items: [{ item: { id: 'ucp-tee' }, quantity: 1 }] });
    const s = (await created.json()) as UcpCheckoutSession;
    const cancelled = await SELF.fetch(`https://o.test/ucp/checkout-sessions/${s.id}/cancel`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(((await cancelled.json()) as UcpCheckoutSession).status).toBe('canceled');

    const put = await SELF.fetch(`https://o.test/ucp/checkout-sessions/${s.id}`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ fulfillment: FULFILLMENT }),
    });
    expect(put.status).toBe(409);

    const done = await SELF.fetch(`https://o.test/ucp/checkout-sessions/${s.id}/complete`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        payment_data: { credential: { type: 'token', token: 'tok_test' } },
      }),
    });
    expect(done.status).toBe(409);
  });
});

describe('UCP order finalization', () => {
  function session(id: string, itemId: string, qty: number, total: number): UcpCheckoutSession {
    return {
      id,
      status: 'ready_for_complete',
      currency: 'usd',
      line_items: [
        {
          id: `line_${itemId}`,
          item: { id: itemId, title: itemId, price: 2500 },
          quantity: qty,
          totals: [
            { type: 'subtotal', amount: 2500 * qty },
            { type: 'total', amount: 2500 * qty },
          ],
        },
      ],
      payment: { handlers: [] },
      totals: [{ type: 'total', amount: total, display_text: 'Total' }],
      messages: [],
      links: [],
      ucp: { version: UCP_VERSION, capabilities: [] },
    };
  }

  it('finalizeUcpOrder writes a paid order from a completed session', async () => {
    const order = await finalizeUcpOrder(
      testEnv,
      'default',
      session('ucp_finalize', 'ucp-tee', 2, 5500),
      'pi_ucp_123',
      1_700_000_000_000,
    );
    expect(order.order_id).toBe('ucp_order_ucp_finalize');
    expect(order.order_permalink_url).toContain(order.order_id);

    const stored = await getOrder(testEnv, 'default', order.order_id);
    expect(stored!.status).toBe('paid');
    expect(stored!.total_cents).toBe(5500);
    expect(stored!.stripe_ref).toBe('pi_ucp_123');
  });

  it('finalizeUcpOrder is idempotent per session — no duplicate order or double inventory decrement', async () => {
    await upsertProduct(testEnv, product('ucp-idem', { title: 'Idem', inventory: 10 }));
    const s = session('ucp_idem_session', 'ucp-idem', 3, 7500);

    // Simulate a retried / concurrent `complete`: finalize the same session twice.
    const first = await finalizeUcpOrder(testEnv, 'default', s, 'pi_idem', 1_700_000_000_000);
    const second = await finalizeUcpOrder(testEnv, 'default', s, 'pi_idem', 1_700_000_000_001);

    // Same deterministic order id both times — no duplicate order.
    expect(second.order_id).toBe(first.order_id);
    expect(first.order_id).toBe('ucp_order_ucp_idem_session');

    // Inventory dropped by exactly the quantity once (10 → 7), not twice.
    const after = await getProduct(testEnv, 'default', 'ucp-idem');
    expect(after!.inventory).toBe(7);
  });
});
