/**
 * Billing provider seam end-to-end: the default internal provider, a custom
 * registered provider (proving Orderloop isn't locked to Stripe), the webhook
 * mark-paid path, and the provider config surface.
 */

import { env, SELF } from 'cloudflare:test';
import { accountStore, buyerStore } from '@felix/commerce/b2b/store';
import { beforeAll, describe, expect, it } from 'vitest';
import '@felix/commerce/b2b/quote-store';
import type { Account, Buyer } from '@felix/commerce/b2b/models';
import type { Invoice } from '@felix/commerce/b2b/quote-models';
import {
  acceptQuote,
  convertQuote,
  createQuote,
  markInvoicePaidByRef,
  payInvoice,
  sendQuote,
} from '@felix/commerce/b2b/service';
import { setBillingSettings } from '@felix/commerce/billing/config-store';
import { registerBillingProvider } from '@felix/commerce/billing/registry';
import { upsertProduct } from '@felix/commerce/catalog-store';
import type { Product } from '@felix/commerce/models';
import type { Env as AppEnv } from '@felix/harness/env';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;

function product(tenant: string, id: string, price: number): Product {
  return {
    tenant_id: tenant,
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
function account(tenant: string, id: string): Account {
  return {
    tenant_id: tenant,
    id,
    name: id,
    status: 'active',
    payment_terms: 'net30',
    credit_limit_cents: 1_000_000_000,
    currency: 'usd',
    metadata: {},
    created_at: 1,
  };
}
function buyer(tenant: string, id: string, account_id: string): Buyer {
  return {
    tenant_id: tenant,
    id,
    account_id,
    email: '',
    role: 'purchaser',
    spending_limit_cents: 0,
    status: 'active',
    created_at: 1,
  };
}

async function seed(tenant: string) {
  await upsertProduct(testEnv, product(tenant, 'sku', 1000));
  await accountStore.upsert(testEnv, tenant, account(tenant, 'acct'));
  await buyerStore.upsert(testEnv, tenant, buyer(tenant, 'b', 'acct'));
}

async function quoteToInvoice(tenant: string): Promise<Invoice> {
  const created = await createQuote(testEnv, tenant, {
    account_id: 'acct',
    buyer_id: 'b',
    items: [{ product_id: 'sku', qty: 5 }],
  });
  if (!created.ok) throw new Error(created.code);
  await sendQuote(testEnv, tenant, created.value.id);
  await acceptQuote(testEnv, tenant, created.value.id);
  const converted = await convertQuote(testEnv, tenant, created.value.id);
  if (!converted.ok) throw new Error(converted.code);
  return converted.value.invoice;
}

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
  // A custom PSP — proves the seam isn't Stripe-only.
  registerBillingProvider('mock-psp', () => ({
    kind: 'mock-psp',
    async issueInvoice() {
      return {
        external_ref: 'mock_ext_1',
        hosted_url: 'https://pay.mock/inv/1',
        status: 'open' as const,
      };
    },
    async settle() {
      return { status: 'paid' as const };
    },
  }));
});

describe('default internal provider', () => {
  it('issues a net-terms invoice with no external ref; pay marks it paid', async () => {
    await seed('bill-int');
    const inv = await quoteToInvoice('bill-int');
    expect(inv.provider).toBe('internal');
    expect(inv.external_ref).toBe('');
    expect(inv.hosted_url).toBe('');
    expect(inv.status).toBe('open');

    const paid = await payInvoice(testEnv, 'bill-int', inv.id);
    expect(paid.ok && paid.value.status).toBe('paid');
  });
});

describe('custom billing provider (not Stripe)', () => {
  it('issues through the configured provider and records its refs', async () => {
    await seed('bill-mock');
    await setBillingSettings(testEnv, 'bill-mock', { provider: 'mock-psp', config: {} }, 'test');
    const inv = await quoteToInvoice('bill-mock');
    expect(inv.provider).toBe('mock-psp');
    expect(inv.external_ref).toBe('mock_ext_1');
    expect(inv.hosted_url).toBe('https://pay.mock/inv/1');

    // Webhook path: mark paid by our invoice id (what the PSP webhook resolves).
    expect(await markInvoicePaidByRef(testEnv, 'bill-mock', inv.id)).toBe(true);
    expect(await markInvoicePaidByRef(testEnv, 'bill-mock', inv.id)).toBe(false); // idempotent
  });
});

describe('provider config surface', () => {
  it('reports the current + available providers and rejects unknown ones', async () => {
    const get = await SELF.fetch('https://o.test/b2b/billing/provider');
    const body = (await get.json()) as { provider: string; available: string[] };
    expect(body.available).toEqual(expect.arrayContaining(['internal', 'stripe', 'mock-psp']));

    const bad = await SELF.fetch('https://o.test/b2b/billing/provider', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'does-not-exist' }),
    });
    expect(bad.status).toBe(400);
  });

  it('the webhook is gated on the signing secret', async () => {
    const r = await SELF.fetch('https://o.test/b2b/billing/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // No STRIPE_WEBHOOK_SECRET in the test env → 503.
    expect(r.status).toBe(503);
  });
});
