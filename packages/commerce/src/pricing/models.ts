/**
 * Dynamic-pricing models (Zod). `PricingRule` mirrors `pricing_rules`;
 * `CompetitorPrice` mirrors `competitor_prices` (and is the `competitor_price`
 * entity type). Money is integer cents; adjustments are signed basis points
 * (negative = discount, positive = surge).
 */

import { z } from '@hono/zod-openapi';

export const PricingRuleScope = z.enum(['catalog', 'category', 'product']);
export type PricingRuleScope = z.infer<typeof PricingRuleScope>;

export const PricingRuleKind = z.enum(['time', 'velocity', 'competitor']);
export type PricingRuleKind = z.infer<typeof PricingRuleKind>;

export const PricingRuleConfig = z
  .object({
    floor_cents: z.number().int().nonnegative().optional(),
    ceiling_cents: z.number().int().nonnegative().optional(),
    /** time rule: active hour-of-day window (UTC, 0–23, inclusive, may wrap). */
    start_hour: z.number().int().min(0).max(23).optional(),
    end_hour: z.number().int().min(0).max(23).optional(),
    /** velocity rule: min recent units sold for the adjustment to apply. */
    velocity_threshold: z.number().int().positive().optional(),
  })
  .strict();
export type PricingRuleConfig = z.infer<typeof PricingRuleConfig>;

export const PricingRule = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: z.string().min(1),
    scope: PricingRuleScope.default('catalog'),
    target: z.string().default(''),
    kind: PricingRuleKind,
    adjustment_bps: z.number().int().min(-10_000).max(10_000),
    config: PricingRuleConfig.default({}),
    active: z.boolean().default(true),
    created_at: z.number().int(),
  })
  .strict()
  .openapi('PricingRule');
export type PricingRule = z.infer<typeof PricingRule>;

export const CompetitorPrice = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: z.string().min(1),
    product_id: z.string().min(1),
    source: z.string().default(''),
    price_cents: z.number().int().nonnegative(),
    currency: z.string().default('usd'),
    observed_at: z.number().int(),
  })
  .strict()
  .openapi('CompetitorPrice');
export type CompetitorPrice = z.infer<typeof CompetitorPrice>;
