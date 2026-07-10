/**
 * Competitor-price store (D1) + `competitor_price` entity-type registration.
 *
 * Registering on the entity seam means a tenant can keep competitor prices
 * native (D1, populated by a feed job) OR federate them from an external
 * pricing-intelligence service (http/mcp connector) without changing the
 * dynamic-pricing caller — the same treatment accounts/buyers/quotes get.
 */

import type { Env } from '@felix/orchestrator/env';
import { registerEntityType } from '../entities/registry';
import type { ListOpts, NativeStore, Page, RawRecord } from '../entities/types';
import { CompetitorPrice } from './models';

interface Row {
  tenant_id: string;
  id: string;
  product_id: string;
  source: string;
  price_cents: number;
  currency: string;
  observed_at: number;
}

function rowToCompetitorPrice(r: Row): CompetitorPrice {
  return CompetitorPrice.parse({
    tenant_id: r.tenant_id,
    id: r.id,
    product_id: r.product_id,
    source: r.source,
    price_cents: r.price_cents,
    currency: r.currency,
    observed_at: r.observed_at,
  });
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}
function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export const competitorPriceStore: NativeStore<CompetitorPrice> = {
  async get(env, tenant, id) {
    const row = await env.DB.prepare(
      'SELECT * FROM competitor_prices WHERE tenant_id = ? AND id = ? LIMIT 1',
    )
      .bind(tenant, id)
      .first<Row>();
    return row ? rowToCompetitorPrice(row) : null;
  },
  async list(env, tenant, opts?: ListOpts): Promise<Page<CompetitorPrice>> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const rows = await env.DB.prepare(
      'SELECT * FROM competitor_prices WHERE tenant_id = ? ORDER BY observed_at DESC LIMIT ?',
    )
      .bind(tenant, limit)
      .all<Row>();
    return { items: (rows.results ?? []).map(rowToCompetitorPrice) };
  },
  async upsert(env, tenant, cp) {
    await env.DB.prepare(
      `INSERT INTO competitor_prices
         (tenant_id, id, product_id, source, price_cents, currency, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         product_id = excluded.product_id,
         source = excluded.source,
         price_cents = excluded.price_cents,
         currency = excluded.currency,
         observed_at = excluded.observed_at`,
    )
      .bind(tenant, cp.id, cp.product_id, cp.source, cp.price_cents, cp.currency, cp.observed_at)
      .run();
  },
};

export function mapCompetitorPrice(raw: RawRecord, tenant: string): CompetitorPrice {
  const productId = str(raw.product_id ?? raw.sku ?? raw.id) || 'unknown';
  const source = str(raw.source ?? raw.competitor);
  return CompetitorPrice.parse({
    tenant_id: tenant,
    id: str(raw.id) || `${productId}:${source || 'feed'}`,
    product_id: productId,
    source,
    price_cents: num(raw.price_cents ?? raw.price),
    currency: str(raw.currency, 'usd'),
    observed_at: num(raw.observed_at, 0),
  });
}

/**
 * Lowest observed competitor price for a product (native fast path for the
 * dynamic-pricing competitor rule). Returns null when none is on file.
 */
export async function minCompetitorPriceCents(
  env: Env,
  tenant: string,
  productId: string,
): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT MIN(price_cents) AS min_cents FROM competitor_prices WHERE tenant_id = ? AND product_id = ?',
  )
    .bind(tenant, productId)
    .first<{ min_cents: number | null }>();
  return row?.min_cents ?? null;
}

registerEntityType<CompetitorPrice>({
  type: 'competitor_price',
  native: competitorPriceStore,
  mapper: mapCompetitorPrice,
});
