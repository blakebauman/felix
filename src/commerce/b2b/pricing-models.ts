/**
 * Account/contract pricing models (Zod). Tiers are volume price breaks:
 * the effective unit price is the tier with the highest `min_qty` ≤ quantity.
 */

import { z } from '@hono/zod-openapi';

export const PriceTier = z
  .object({
    min_qty: z.number().int().positive(),
    unit_price_cents: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('PriceTier');
export type PriceTier = z.infer<typeof PriceTier>;

export const ContractPrice = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    account_id: z.string().min(1),
    product_id: z.string().min(1),
    currency: z.string().default('usd'),
    tiers: z.array(PriceTier).default([]),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict()
  .openapi('ContractPrice');
export type ContractPrice = z.infer<typeof ContractPrice>;

export const SetContractPriceRequest = z
  .object({
    currency: z.string().optional(),
    tiers: z.array(PriceTier).min(1),
  })
  .strict()
  .openapi('SetContractPriceRequest');
export type SetContractPriceRequest = z.infer<typeof SetContractPriceRequest>;

/** Effective unit price for `min_qty`, picking the best applicable tier. */
export function effectiveTierPrice(tiers: ReadonlyArray<PriceTier>, qty: number): number | null {
  let best: PriceTier | null = null;
  for (const t of tiers) {
    if (qty >= t.min_qty && (!best || t.min_qty > best.min_qty)) best = t;
  }
  return best ? best.unit_price_cents : null;
}
