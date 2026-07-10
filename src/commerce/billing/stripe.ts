/**
 * Stripe billing provider — net-terms collection via Stripe Invoices.
 *
 * issueInvoice: create a customer for the account, add a single invoice item
 * for the amount, create an invoice with `collection_method: send_invoice` and
 * `days_until_due` from the net terms, finalize it, and return the
 * `hosted_invoice_url`. The Stripe invoice carries our tenant + invoice id in
 * metadata so the webhook can mark it paid. settle: pay-out-of-band (the buyer
 * paid via the hosted invoice; this records it on Stripe).
 *
 * `buildInvoiceParams` is factored out (pure) so its shape is unit-testable
 * without calling Stripe.
 */

import type Stripe from 'stripe';
import type { Env } from '../../env';
import type { Account } from '../b2b/models';
import type { Invoice } from '../b2b/quote-models';
import { stripeClient } from '../stripe-client';
import { registerBillingProvider } from './registry';
import type { BillingProvider } from './types';

export function buildInvoiceParams(
  invoice: Invoice,
  customerId: string,
  netDays: number,
): Stripe.InvoiceCreateParams {
  return {
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: netDays,
    currency: invoice.currency,
    metadata: { orderloop_tenant: invoice.tenant_id, orderloop_invoice_id: invoice.id },
  };
}

class StripeInvoiceProvider implements BillingProvider {
  readonly kind = 'stripe';

  async issueInvoice(env: Env, args: { invoice: Invoice; account: Account; netDays: number }) {
    if (!env.STRIPE_SECRET_KEY) {
      // Not configured — degrade to internal tracking rather than failing the order.
      return { status: 'open' as const };
    }
    const stripe = stripeClient(env);
    const customer = await stripe.customers.create({
      name: args.account.name,
      metadata: { orderloop_account: args.account.id, orderloop_tenant: args.invoice.tenant_id },
    });
    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: args.invoice.amount_cents,
      currency: args.invoice.currency,
      description: `Order ${args.invoice.order_id}`,
    });
    const invoice = await stripe.invoices.create(
      buildInvoiceParams(args.invoice, customer.id, args.netDays),
    );
    const finalized = invoice.id ? await stripe.invoices.finalizeInvoice(invoice.id) : invoice;
    return {
      external_ref: finalized.id,
      hosted_url: finalized.hosted_invoice_url ?? undefined,
      status: 'open' as const,
    };
  }

  async settle(env: Env, invoice: Invoice) {
    if (env.STRIPE_SECRET_KEY && invoice.external_ref) {
      // Buyer paid out of band (cheque/ACH/wire) — record it on Stripe.
      await stripeClient(env)
        .invoices.pay(invoice.external_ref, { paid_out_of_band: true })
        .catch(() => {});
    }
    return { status: 'paid' as const, external_ref: invoice.external_ref };
  }
}

registerBillingProvider('stripe', () => new StripeInvoiceProvider());
