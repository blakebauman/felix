/**
 * Tax seam. v1 is a flat configurable rate in basis points
 * (`COMMERCE_TAX_BPS`, default 0 — no tax). The signature takes the address
 * and line context so a real tax provider (Stripe Tax, TaxJar, Avalara) can
 * replace `computeTax` without touching callers.
 *
 * Tax is computed on (subtotal + shipping) in integer cents and rounded to the
 * nearest cent. Callers own where the resulting `tax` total lands.
 */

import type { Env } from '@felix/harness/env';
import type { AcpAddress } from './acp/models';

/** Parse the configured rate in basis points (100 bps = 1%). Clamped to 0–10000. */
export function parseTaxBps(env: Env): number {
  const raw = env.COMMERCE_TAX_BPS;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 10_000);
}

export interface TaxInput {
  subtotalCents: number;
  shippingCents: number;
  address?: AcpAddress;
}

/**
 * Compute tax in integer cents. Pure given the parsed rate — `env` is only
 * read to resolve configuration, so this stays trivially testable.
 */
export function computeTax(env: Env, input: TaxInput): number {
  const bps = parseTaxBps(env);
  if (bps === 0) return 0;
  const base = Math.max(0, input.subtotalCents + input.shippingCents);
  return Math.round((base * bps) / 10_000);
}
