/**
 * Billing provider seam: registry, the internal provider, and the Stripe
 * invoice param shape (pure — no Stripe call).
 */

import { describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/commerce/b2b/quote-models';
import { getBillingProvider, listBillingProviders } from '../../src/commerce/billing/registry';
import { buildInvoiceParams } from '../../src/commerce/billing/stripe';
// Side-effect: register the built-ins.
import '../../src/commerce/billing/internal';
import '../../src/commerce/billing/stripe';

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    tenant_id: 't',
    id: 'inv_1',
    account_id: 'acme',
    quote_id: 'q_1',
    order_id: 'o_1',
    amount_cents: 50000,
    currency: 'usd',
    terms: 'net30',
    status: 'open',
    due_at: 0,
    created_at: 0,
    paid_at: null,
    provider: 'stripe',
    external_ref: '',
    hosted_url: '',
    ...over,
  };
}

describe('billing registry', () => {
  it('registers the built-in providers', () => {
    expect(listBillingProviders()).toEqual(expect.arrayContaining(['internal', 'stripe']));
  });
  it('throws on an unknown provider', () => {
    expect(() => getBillingProvider('nope')).toThrow();
  });
});

describe('internal provider', () => {
  it('issues without an external ref and settles as paid', async () => {
    const p = getBillingProvider('internal');
    expect(
      await p.issueInvoice({} as never, { invoice: invoice(), account: {} as never, netDays: 30 }),
    ).toEqual({
      status: 'open',
    });
    expect(await p.settle({} as never, invoice())).toEqual({ status: 'paid' });
  });
});

describe('stripe invoice params', () => {
  it('uses send_invoice collection with net-terms days + orderloop metadata', () => {
    const params = buildInvoiceParams(invoice(), 'cus_123', 30);
    expect(params.customer).toBe('cus_123');
    expect(params.collection_method).toBe('send_invoice');
    expect(params.days_until_due).toBe(30);
    expect(params.currency).toBe('usd');
    expect(params.metadata).toEqual({ orderloop_tenant: 't', orderloop_invoice_id: 'inv_1' });
  });
});
