/**
 * B2B service layer — the single implementation of the quote-to-cash + purchase
 * authority operations, shared by the HTTP routers and the agent tools. Returns
 * tagged-union results so callers map them to HTTP responses or tool strings.
 *
 * Reuses the entity seam for account/buyer/quote/invoice reads, the approvals
 * pipeline for over-limit gating, and the `orders` table for the generated
 * order.
 */

import { createOrFetchRequest, getRequest } from '@felix/orchestrator/approvals/store';
import { recordEvent } from '@felix/orchestrator/audit/store';
import type { Env } from '@felix/orchestrator/env';
import { resolveBillingProvider } from '../billing/resolve';
import { resolveEntitySource } from '../entities/resolver';
import type { Order } from '../models';
import { createOrder } from '../order-store';
import { type AuthorityDecision, purchaseAuthority } from './authority';
import type { Account, Buyer, PaymentTerms } from './models';
import { dueAt, netDays, priceQuote, type QuoteLineInput } from './quote-logic';
import type { Invoice, Quote } from './quote-models';
import { invoiceStore, quoteStore } from './quote-store';

export type Result<T> = { ok: true; value: T } | { ok: false; code: string; detail?: unknown };

const fail = (code: string, detail?: unknown): Result<never> => ({ ok: false, code, detail });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

async function loadAccountBuyer(
  env: Env,
  tenant: string,
  accountId: string,
  buyerId: string,
): Promise<{ account: Account; buyer: Buyer } | null> {
  const accounts = await resolveEntitySource<Account>(env, tenant, 'account');
  const buyers = await resolveEntitySource<Buyer>(env, tenant, 'buyer');
  const account = await accounts.get(accountId);
  const buyer = await buyers.get(buyerId);
  return account && buyer ? { account, buyer } : null;
}

export interface AuthorityCheck {
  decision: AuthorityDecision;
  reason: string;
  approval_id?: string;
}

/** Spending authority for an ad-hoc amount; creates an approval if over-limit. */
export async function authorityCheck(
  env: Env,
  tenant: string,
  accountId: string,
  buyerId: string,
  amountCents: number,
  note?: string,
): Promise<Result<AuthorityCheck>> {
  const account = await (await resolveEntitySource<Account>(env, tenant, 'account')).get(accountId);
  if (!account) return fail('account_not_found');
  const buyer = await (await resolveEntitySource<Buyer>(env, tenant, 'buyer')).get(buyerId);
  if (!buyer) return fail('buyer_not_found');

  const result = purchaseAuthority(account, buyer, amountCents);
  let approvalId: string | undefined;
  if (result.decision === 'requires_approval') {
    const req = await createOrFetchRequest(env, {
      tenantId: tenant,
      manifestId: 'orderloop',
      toolName: 'b2b_purchase',
      callSignature: `${accountId}:${buyerId}:${amountCents}`,
      args: {
        account_id: accountId,
        buyer_id: buyerId,
        amount_cents: amountCents,
        ...(note ? { note } : {}),
      },
      principalSubject: buyerId,
    });
    approvalId = req.id;
  }
  recordEvent({
    tenantId: tenant,
    eventType: 'b2b_purchase_check',
    manifestId: 'orderloop',
    status: result.decision === 'blocked' ? 'denied' : 'ok',
    payload: {
      account_id: accountId,
      buyer_id: buyerId,
      amount_cents: amountCents,
      decision: result.decision,
      ...(approvalId ? { approval_id: approvalId } : {}),
    },
  });
  return ok({
    decision: result.decision,
    reason: result.reason,
    ...(approvalId ? { approval_id: approvalId } : {}),
  });
}

export async function createQuote(
  env: Env,
  tenant: string,
  input: { account_id: string; buyer_id: string; items: QuoteLineInput[]; notes?: string },
): Promise<Result<Quote>> {
  const ab = await loadAccountBuyer(env, tenant, input.account_id, input.buyer_id);
  if (!ab) return fail('account_or_buyer_not_found');
  if (ab.buyer.account_id !== input.account_id) return fail('buyer_not_in_account');

  const priced = await priceQuote(env, tenant, input.account_id, input.items);
  if (priced.errors.length) return fail('pricing_failed', priced.errors);

  const now = Date.now();
  const quote: Quote = {
    tenant_id: tenant,
    id: `q_${crypto.randomUUID()}`,
    account_id: input.account_id,
    buyer_id: input.buyer_id,
    status: 'draft',
    currency: priced.currency,
    subtotal_cents: priced.subtotal_cents,
    discount_cents: priced.discount_cents,
    total_cents: priced.total_cents,
    valid_until: null,
    approval_id: '',
    order_id: '',
    notes: input.notes ?? '',
    items: priced.items,
    created_at: now,
    updated_at: now,
  };
  await quoteStore.upsert(env, tenant, quote);
  return ok(quote);
}

export async function sendQuote(
  env: Env,
  tenant: string,
  id: string,
  validDays = 14,
): Promise<Result<Quote>> {
  const quote = await quoteStore.get(env, tenant, id);
  if (!quote) return fail('not_found');
  if (quote.status !== 'draft') return fail('invalid_state', quote.status);
  const now = Date.now();
  const next: Quote = {
    ...quote,
    status: 'sent',
    valid_until: now + validDays * 86_400_000,
    updated_at: now,
  };
  await quoteStore.upsert(env, tenant, next);
  return ok(next);
}

export async function acceptQuote(env: Env, tenant: string, id: string): Promise<Result<Quote>> {
  const quote = await quoteStore.get(env, tenant, id);
  if (!quote) return fail('not_found');
  if (quote.status !== 'sent') return fail('invalid_state', quote.status);
  const now = Date.now();
  if (quote.valid_until && quote.valid_until < now) {
    await quoteStore.upsert(env, tenant, { ...quote, status: 'expired', updated_at: now });
    return fail('expired');
  }
  const ab = await loadAccountBuyer(env, tenant, quote.account_id, quote.buyer_id);
  if (!ab) return fail('account_or_buyer_missing');

  const authority = purchaseAuthority(ab.account, ab.buyer, quote.total_cents);
  if (authority.decision === 'blocked') return fail('not_authorized', authority.reason);

  if (authority.decision === 'requires_approval') {
    const req = await createOrFetchRequest(env, {
      tenantId: tenant,
      manifestId: 'orderloop',
      toolName: 'b2b_purchase',
      callSignature: `quote:${quote.id}`,
      args: {
        quote_id: quote.id,
        account_id: quote.account_id,
        buyer_id: quote.buyer_id,
        amount_cents: quote.total_cents,
      },
      principalSubject: quote.buyer_id,
    });
    const next: Quote = {
      ...quote,
      status: 'pending_approval',
      approval_id: req.id,
      updated_at: now,
    };
    await quoteStore.upsert(env, tenant, next);
    return ok(next);
  }
  const next: Quote = { ...quote, status: 'accepted', updated_at: now };
  await quoteStore.upsert(env, tenant, next);
  return ok(next);
}

export async function convertQuote(
  env: Env,
  tenant: string,
  id: string,
): Promise<Result<{ order_id: string; invoice: Invoice }>> {
  const quote = await quoteStore.get(env, tenant, id);
  if (!quote) return fail('not_found');

  let ready = quote.status === 'accepted';
  if (quote.status === 'pending_approval' && quote.approval_id) {
    const approval = await getRequest(env, tenant, quote.approval_id);
    ready = approval?.status === 'approved';
  }
  if (!ready) return fail('not_ready', quote.status);

  const account = await (await resolveEntitySource<Account>(env, tenant, 'account')).get(
    quote.account_id,
  );
  if (!account) return fail('account_not_found');
  const terms = account.payment_terms as PaymentTerms;
  const now = Date.now();

  const orderId = crypto.randomUUID();
  const order: Order = {
    tenant_id: tenant,
    id: orderId,
    thread_id: '',
    stripe_ref: '',
    total_cents: quote.total_cents,
    currency: quote.currency,
    status: 'pending',
    created_at: now,
    items: quote.items.map((it) => ({
      product_id: it.product_id,
      title: it.title,
      qty: it.qty,
      price_cents: it.unit_price_cents,
    })),
  };
  await createOrder(env, order);

  // Issue the invoice through the configured billing provider (internal /
  // stripe / …) so net-terms collection isn't locked to one PSP.
  const provider = await resolveBillingProvider(env, tenant);
  const base: Invoice = {
    tenant_id: tenant,
    id: `inv_${crypto.randomUUID()}`,
    account_id: quote.account_id,
    quote_id: quote.id,
    order_id: orderId,
    amount_cents: quote.total_cents,
    currency: quote.currency,
    terms,
    status: 'open',
    due_at: dueAt(terms, now),
    created_at: now,
    paid_at: null,
    provider: provider.kind,
    external_ref: '',
    hosted_url: '',
  };
  let issued: { external_ref?: string; hosted_url?: string; status?: 'open' | 'paid' } = {};
  try {
    issued = await provider.issueInvoice(env, { invoice: base, account, netDays: netDays(terms) });
  } catch {
    /* degrade to internal tracking */
  }
  const invoice: Invoice = {
    ...base,
    external_ref: issued.external_ref ?? '',
    hosted_url: issued.hosted_url ?? '',
    status: issued.status ?? 'open',
  };
  await invoiceStore.upsert(env, tenant, invoice);
  await quoteStore.upsert(env, tenant, {
    ...quote,
    status: 'ordered',
    order_id: orderId,
    updated_at: now,
  });

  recordEvent({
    tenantId: tenant,
    eventType: 'b2b_quote',
    manifestId: 'orderloop',
    status: 'ok',
    payload: {
      quote_id: quote.id,
      order_id: orderId,
      invoice_id: invoice.id,
      total_cents: quote.total_cents,
      terms,
    },
  });
  return ok({ order_id: orderId, invoice });
}

export async function payInvoice(env: Env, tenant: string, id: string): Promise<Result<Invoice>> {
  const inv = await invoiceStore.get(env, tenant, id);
  if (!inv) return fail('not_found');
  if (inv.status === 'paid') return ok(inv);
  // Let the provider record the settlement (pay-out-of-band on the PSP, etc.).
  const provider = await resolveBillingProvider(env, tenant);
  await provider.settle(env, inv).catch(() => {});
  const paid: Invoice = { ...inv, status: 'paid', paid_at: Date.now() };
  await invoiceStore.upsert(env, tenant, paid);
  return ok(paid);
}

/** Mark an invoice paid by its provider external ref (used by the webhook). */
export async function markInvoicePaidByRef(
  env: Env,
  tenant: string,
  invoiceId: string,
): Promise<boolean> {
  const inv = await invoiceStore.get(env, tenant, invoiceId);
  if (!inv || inv.status === 'paid') return false;
  await invoiceStore.upsert(env, tenant, { ...inv, status: 'paid', paid_at: Date.now() });
  return true;
}
