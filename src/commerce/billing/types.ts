/**
 * Billing provider seam — types.
 *
 * Net-terms invoice collection is virtualized behind a provider so Orderloop is
 * not locked to Stripe. A provider issues an invoice for collection (returning
 * an external ref + hosted payment URL) and settles it. Built-ins: `internal`
 * (manual mark-paid, the default) and `stripe` (Stripe Invoices). Others
 * register via `registerBillingProvider`.
 */

import type { Env } from '../../env';
import type { Account } from '../b2b/models';
import type { Invoice } from '../b2b/quote-models';

export interface IssueResult {
  external_ref?: string;
  hosted_url?: string;
  status?: 'open' | 'paid';
}

export interface BillingProvider {
  readonly kind: string;
  /** Issue the invoice for collection (e.g. create + send a Stripe Invoice). */
  issueInvoice(
    env: Env,
    args: { invoice: Invoice; account: Account; netDays: number },
  ): Promise<IssueResult>;
  /** Settle the invoice (manual mark-paid, or pay-out-of-band on the PSP). */
  settle(env: Env, invoice: Invoice): Promise<{ status: 'paid'; external_ref?: string }>;
}

export type BillingProviderFactory = (config: Record<string, unknown>) => BillingProvider;
