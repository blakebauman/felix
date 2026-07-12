/**
 * Quote-to-cash end-to-end: RFQ → send → accept → convert → invoice → pay,
 * plus the approval-gated path for an over-limit accept and the expiry guard.
 */

import { env, SELF } from 'cloudflare:test';
import type { Invoice, Quote } from '@felix/commerce/b2b/quote-models';
import { upsertProduct } from '@felix/commerce/catalog-store';
import { beforeAll, describe, expect, it } from 'vitest';
import '@felix/commerce/b2b/store';
import '@felix/commerce/b2b/quote-store';
import type { Product } from '@felix/commerce/models';
import { getDb } from '@felix/harness/db/client';
import type { Env as AppEnv } from '@felix/harness/env';

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
    inventory: 100,
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

beforeAll(async () => {
  await upsertProduct(testEnv, product('widget', 1000));
  // Account on net-30 terms with a buyer limited to $50.
  await post('/b2b/accounts', {
    id: 'q-acct',
    name: 'Q Acct',
    payment_terms: 'net30',
    credit_limit_cents: 10_000_000,
  });
  await post('/b2b/accounts/q-acct/buyers', { id: 'q-buyer', spending_limit_cents: 5000 });
});

async function createSentQuote(qty: number): Promise<Quote> {
  const created = await post('/b2b/quotes', {
    account_id: 'q-acct',
    buyer_id: 'q-buyer',
    items: [{ product_id: 'widget', qty }],
  });
  const quote = (await created.json()) as Quote;
  await post(`/b2b/quotes/${quote.id}/send`, { valid_days: 7 });
  return quote;
}

describe('quote-to-cash happy path (within limit)', () => {
  it('RFQ → send → accept → convert → invoice → pay', async () => {
    const quote = await createSentQuote(4); // 4 * $10 = $40, under the $50 limit

    const accept = await post(`/b2b/quotes/${quote.id}/accept`);
    expect(((await accept.json()) as Quote).status).toBe('accepted');

    const convert = await post(`/b2b/quotes/${quote.id}/convert`);
    const body = (await convert.json()) as { order_id: string; invoice: Invoice };
    expect(body.order_id).toBeTruthy();
    expect(body.invoice.amount_cents).toBe(4000);
    expect(body.invoice.terms).toBe('net30');
    // due ~30 days out
    expect(body.invoice.due_at).toBeGreaterThan(body.invoice.created_at);

    const pay = await post(`/b2b/invoices/${body.invoice.id}/pay`);
    expect(((await pay.json()) as Invoice).status).toBe('paid');
  });
});

describe('quote-to-cash with approval routing (over limit)', () => {
  it('over-limit accept routes to approval; convert blocked until approved', async () => {
    const quote = await createSentQuote(9); // 9 * $10 = $90, over the $50 limit

    const accept = await post(`/b2b/quotes/${quote.id}/accept`);
    const accepted = (await accept.json()) as Quote & { approval_id: string };
    expect(accepted.status).toBe('pending_approval');
    expect(accepted.approval_id).toBeTruthy();

    // Convert is blocked while the approval is pending.
    const early = await post(`/b2b/quotes/${quote.id}/convert`);
    expect(early.status).toBe(409);

    // Approve via the existing pipeline, then convert succeeds.
    await post(`/approvals/${accepted.approval_id}/decide`, { status: 'approved' });
    const convert = await post(`/b2b/quotes/${quote.id}/convert`);
    expect(convert.status).toBe(200);
    expect(((await convert.json()) as { order_id: string }).order_id).toBeTruthy();
  });
});

describe('quote guards', () => {
  it('rejects accepting an expired quote', async () => {
    const created = await post('/b2b/quotes', {
      account_id: 'q-acct',
      buyer_id: 'q-buyer',
      items: [{ product_id: 'widget', qty: 1 }],
    });
    const quote = (await created.json()) as Quote;
    // Send, then backdate validity into the past via D1.
    await post(`/b2b/quotes/${quote.id}/send`, { valid_days: 1 });
    await getDb(testEnv)`
      UPDATE quotes SET valid_until = 1 WHERE tenant_id = 'default' AND id = ${quote.id}
    `;
    const accept = await post(`/b2b/quotes/${quote.id}/accept`);
    expect(accept.status).toBe(409);
    expect(((await accept.json()) as { error: string }).error).toBe('expired');
  });
});
