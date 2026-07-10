/**
 * Effective B2B price resolution. Precedence for a quote line:
 *   1. contract tier price for (account, product) at the line quantity
 *   2. account-level discount (account.metadata.discount_bps off catalog)
 *   3. catalog price — optionally adjusted by dynamic pricing rules
 *
 * A seller's explicit per-line override (handled in quote pricing) still wins
 * over all of these. Dynamic pricing only applies to the *catalog* branch:
 * negotiated contract tiers and account discounts are never re-priced by
 * demand/competitor signals, preserving the documented precedence.
 */

import { resolveEntitySource } from '../../entities/resolver';
import type { Env } from '../../env';
import { applyDynamicAdjustments, type DynamicSignals } from '../pricing/dynamic';
import type { Account } from './models';
import { effectiveTierPrice } from './pricing-models';
import { getContractPrice } from './pricing-store';

export interface PriceResolution {
  unit_price_cents: number;
  source: 'contract' | 'account_discount' | 'catalog' | 'dynamic';
}

/** Optional dynamic-pricing inputs. Omit to keep the original static behavior. */
export interface DynamicPricingOpts {
  category: string;
  signals: DynamicSignals;
}

function accountDiscountBps(account: Account | null): number {
  const raw = account?.metadata?.discount_bps;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 10_000);
}

export async function resolveEffectivePrice(
  env: Env,
  tenant: string,
  accountId: string,
  productId: string,
  qty: number,
  catalogPriceCents: number,
  account?: Account | null,
  dynamic?: DynamicPricingOpts,
): Promise<PriceResolution> {
  const contract = await getContractPrice(env, tenant, accountId, productId);
  if (contract) {
    const tier = effectiveTierPrice(contract.tiers, qty);
    if (tier !== null) return { unit_price_cents: tier, source: 'contract' };
  }

  const acct =
    account === undefined
      ? await (await resolveEntitySource<Account>(env, tenant, 'account')).get(accountId)
      : account;
  const bps = accountDiscountBps(acct);
  if (bps > 0) {
    return {
      unit_price_cents: Math.round((catalogPriceCents * (10_000 - bps)) / 10_000),
      source: 'account_discount',
    };
  }

  // Catalog branch — optionally re-priced by dynamic rules (demand / time /
  // competitor). Only here: negotiated prices above are never dynamically moved.
  if (dynamic) {
    const result = await applyDynamicAdjustments(
      env,
      tenant,
      { id: productId, category: dynamic.category },
      catalogPriceCents,
      dynamic.signals,
    );
    if (result.adjusted) return { unit_price_cents: result.price_cents, source: 'dynamic' };
  }
  return { unit_price_cents: catalogPriceCents, source: 'catalog' };
}
