/**
 * Dynamic list-price adjustment. Applies the tenant's active `pricing_rules`
 * (time-of-day / inventory-velocity / competitor-match) to a base catalog price,
 * summing the matching rules' basis-point adjustments and clamping the result to
 * any floor/ceiling the rules declare.
 *
 * Adjustments are signed bps: negative discounts, positive surges. The
 * competitor rule reads the lowest observed competitor price (via the
 * `competitor_price` entity store — importing it also registers the entity type
 * on the seam). Velocity input is injected by the caller so the function stays
 * decoupled from how "recent demand" is measured.
 *
 * Two entry points share one pure core (`evaluateRules`):
 *   - `applyDynamicAdjustments` — single product (B2B quote pricing).
 *   - `applyDynamicToCatalog`   — a batch (D2C catalog display): loads rules
 *     ONCE and resolves demand / competitor signals only for products a rule
 *     actually matches, keeping the catalog hot path cheap.
 */

import type { Env } from '@felix/orchestrator/env';
import { minCompetitorPriceCents } from './competitor-store';
import type { PricingRule } from './models';
import { listActiveRules } from './rules-store';

export interface DynamicProduct {
  id: string;
  category: string;
}

export interface DynamicSignals {
  nowMs: number;
  /** Recent units sold over the demand window, for velocity rules. */
  recentUnitsSold?: number;
}

export interface DynamicResult {
  price_cents: number;
  /** True when at least one rule changed the price. */
  adjusted: boolean;
  reasons: string[];
}

/** Resolved signals a rule is evaluated against (no I/O at this layer). */
interface RuleContext {
  nowMs: number;
  demand: number;
  competitorMin: number | null;
}

function matchesScope(rule: PricingRule, product: DynamicProduct): boolean {
  if (rule.scope === 'catalog') return true;
  if (rule.scope === 'category') return !!product.category && rule.target === product.category;
  if (rule.scope === 'product') return rule.target === product.id;
  return false;
}

function inHourWindow(hour: number, start: number, end: number): boolean {
  // Inclusive window; supports wrap-around (e.g. 22→4 overnight).
  return start <= end ? hour >= start && hour <= end : hour >= start || hour <= end;
}

function ruleApplies(rule: PricingRule, ctx: RuleContext): boolean {
  if (rule.kind === 'time') {
    const { start_hour, end_hour } = rule.config;
    if (start_hour === undefined || end_hour === undefined) return true;
    return inHourWindow(new Date(ctx.nowMs).getUTCHours(), start_hour, end_hour);
  }
  if (rule.kind === 'velocity') {
    return ctx.demand >= (rule.config.velocity_threshold ?? 1);
  }
  if (rule.kind === 'competitor') {
    return ctx.competitorMin !== null;
  }
  return false;
}

/** Pure: given resolved signals, compute the adjusted price for one product. */
function evaluateRules(
  rules: PricingRule[],
  product: DynamicProduct,
  basePriceCents: number,
  ctx: RuleContext,
): DynamicResult {
  let bps = 0;
  let floor = 0;
  let ceiling = Number.POSITIVE_INFINITY;
  const reasons: string[] = [];

  for (const rule of rules) {
    if (!matchesScope(rule, product)) continue;
    if (!ruleApplies(rule, ctx)) continue;
    bps += rule.adjustment_bps;
    reasons.push(`${rule.kind}:${rule.adjustment_bps >= 0 ? '+' : ''}${rule.adjustment_bps}bps`);
    if (rule.config.floor_cents !== undefined) floor = Math.max(floor, rule.config.floor_cents);
    if (rule.config.ceiling_cents !== undefined)
      ceiling = Math.min(ceiling, rule.config.ceiling_cents);
  }

  if (reasons.length === 0) {
    return { price_cents: basePriceCents, adjusted: false, reasons: [] };
  }

  let price = Math.round((basePriceCents * (10_000 + bps)) / 10_000);
  price = Math.max(floor, price);
  if (Number.isFinite(ceiling)) price = Math.min(ceiling, price);
  price = Math.max(0, price);
  return { price_cents: price, adjusted: price !== basePriceCents, reasons };
}

/** True if any scope-matching rule of `kind` exists for the product. */
function hasKind(
  rules: PricingRule[],
  product: DynamicProduct,
  kind: PricingRule['kind'],
): boolean {
  return rules.some((r) => r.kind === kind && matchesScope(r, product));
}

export async function applyDynamicAdjustments(
  env: Env,
  tenant: string,
  product: DynamicProduct,
  basePriceCents: number,
  signals: DynamicSignals,
): Promise<DynamicResult> {
  let rules: PricingRule[];
  try {
    rules = await listActiveRules(env, tenant);
  } catch {
    return { price_cents: basePriceCents, adjusted: false, reasons: [] };
  }
  if (rules.length === 0) return { price_cents: basePriceCents, adjusted: false, reasons: [] };

  // Only query competitor prices when a competitor rule could apply.
  const competitorMin = hasKind(rules, product, 'competitor')
    ? await minCompetitorPriceCents(env, tenant, product.id)
    : null;
  return evaluateRules(rules, product, basePriceCents, {
    nowMs: signals.nowMs,
    demand: signals.recentUnitsSold ?? 0,
    competitorMin,
  });
}

export interface PricedProduct {
  id: string;
  category: string;
  price_cents: number;
}

/**
 * Batch dynamic pricing for a catalog page. Loads rules once; resolves the
 * velocity demand (`demandFn`) and competitor price only for products a rule
 * matches. Returns a map keyed by product id (only entries that changed).
 */
export async function applyDynamicToCatalog(
  env: Env,
  tenant: string,
  products: PricedProduct[],
  nowMs: number,
  demandFn: (productId: string) => Promise<number>,
): Promise<Map<string, DynamicResult>> {
  const out = new Map<string, DynamicResult>();
  let rules: PricingRule[];
  try {
    rules = await listActiveRules(env, tenant);
  } catch {
    return out;
  }
  if (rules.length === 0) return out;

  for (const p of products) {
    const demand = hasKind(rules, p, 'velocity') ? await demandFn(p.id) : 0;
    const competitorMin = hasKind(rules, p, 'competitor')
      ? await minCompetitorPriceCents(env, tenant, p.id)
      : null;
    const result = evaluateRules(rules, p, p.price_cents, { nowMs, demand, competitorMin });
    if (result.adjusted) out.set(p.id, result);
  }
  return out;
}
