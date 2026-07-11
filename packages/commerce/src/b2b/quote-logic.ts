/**
 * Quote-to-cash pricing + helpers. Each line's unit price resolves as: explicit
 * per-line override → account/contract pricing (volume tiers / account discount)
 * → catalog price. Totals are computed server-side; net-terms due dates derive
 * from the account's payment terms.
 */

import type { Env } from '@felix/harness/env';
import { getProduct } from '../catalog-store';
import { resolveEntitySource } from '../entities/resolver';
import { countRecentPurchases } from '../personalization/customer-store';
import type { Account, PaymentTerms } from './models';
import { resolveEffectivePrice } from './pricing';
import type { QuoteItem } from './quote-models';

/** Demand window for velocity-based dynamic pricing. */
const DEMAND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface QuoteLineInput {
  product_id: string;
  qty: number;
  unit_price_cents?: number;
  discount_cents?: number;
}

export interface PricedQuote {
  items: QuoteItem[];
  currency: string;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  errors: string[];
}

/**
 * Resolve lines against the catalog + account/contract pricing and compute
 * line + quote totals. A per-line `unit_price_cents` override wins; otherwise
 * the effective price comes from contract tiers / account discount / catalog.
 */
export async function priceQuote(
  env: Env,
  tenant: string,
  accountId: string,
  lines: QuoteLineInput[],
): Promise<PricedQuote> {
  const items: QuoteItem[] = [];
  const errors: string[] = [];
  let currency = 'usd';
  // Resolve the account once for account-level discounts. Defensive: if the
  // account source is unavailable, pricing degrades to contract tiers / catalog.
  let account: Account | null = null;
  try {
    account = await (await resolveEntitySource<Account>(env, tenant, 'account')).get(accountId);
  } catch {
    account = null;
  }
  for (const line of lines) {
    const product = await getProduct(env, tenant, line.product_id);
    if (!product) {
      errors.push(`unknown product '${line.product_id}'`);
      continue;
    }
    currency = product.currency;
    const nowMs = Date.now();
    const unit =
      line.unit_price_cents ??
      (
        await resolveEffectivePrice(
          env,
          tenant,
          accountId,
          product.id,
          line.qty,
          product.price_cents,
          account,
          {
            category: product.category,
            signals: {
              nowMs,
              recentUnitsSold: await countRecentPurchases(
                env,
                tenant,
                product.id,
                nowMs - DEMAND_WINDOW_MS,
              ),
            },
          },
        )
      ).unit_price_cents;
    const discount = line.discount_cents ?? 0;
    const lineTotal = Math.max(0, unit * line.qty - discount);
    items.push({
      product_id: product.id,
      title: product.title,
      qty: line.qty,
      unit_price_cents: unit,
      discount_cents: discount,
      line_total_cents: lineTotal,
    });
  }
  const subtotal = items.reduce((s, it) => s + it.unit_price_cents * it.qty, 0);
  const discount = items.reduce((s, it) => s + it.discount_cents, 0);
  const total = items.reduce((s, it) => s + it.line_total_cents, 0);
  return {
    items,
    currency,
    subtotal_cents: subtotal,
    discount_cents: discount,
    total_cents: total,
    errors,
  };
}

/** Net-terms window in days; prepaid is due immediately. */
export function netDays(terms: PaymentTerms): number {
  switch (terms) {
    case 'net15':
      return 15;
    case 'net30':
      return 30;
    case 'net60':
      return 60;
    default:
      return 0;
  }
}

export function dueAt(terms: PaymentTerms, nowMs: number): number {
  return nowMs + netDays(terms) * 86_400_000;
}
