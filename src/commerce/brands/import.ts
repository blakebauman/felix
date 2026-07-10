/**
 * Catalog import. Maps an inbound payload (plain JSON products or the ACP
 * product-feed shape we also emit) into `Product` rows under the brand's data
 * tenant. Idempotent per id via `upsertProduct`.
 */

import type { Env } from '../../env';
import { upsertProduct } from '../catalog-store';
import type { Product } from '../models';
import type { ImportRequest } from './models';

export interface ImportResult {
  imported: number;
  errors: Array<{ id: string; error: string }>;
}

/** Parse an ACP price string like "25.00 USD" → { cents, currency }. */
export function parsePrice(price: string): { cents: number; currency: string } {
  const [amount, code] = price.trim().split(/\s+/);
  const value = Number.parseFloat(amount ?? '');
  const cents = Number.isFinite(value) ? Math.round(value * 100) : 0;
  return { cents, currency: (code ?? 'USD').toLowerCase() };
}

function toProducts(tenantId: string, req: ImportRequest, nowMs: number): Product[] {
  if (req.format === 'json') {
    return req.products.map((p) => ({
      tenant_id: tenantId,
      id: p.id,
      title: p.title,
      description: p.description ?? '',
      price_cents: p.price_cents,
      currency: p.currency ?? 'usd',
      image_url: p.image_url ?? '',
      category: p.category ?? '',
      inventory: p.inventory ?? -1,
      active: true,
      attrs: p.attrs ?? {},
      created_at: nowMs,
    }));
  }
  // acp_feed
  return req.products.map((p) => {
    const { cents, currency } = parsePrice(p.price);
    const inStock = (p.availability ?? 'in_stock') === 'in_stock';
    return {
      tenant_id: tenantId,
      id: p.item_id,
      title: p.title,
      description: p.description ?? '',
      price_cents: cents,
      currency,
      image_url: p.image_url ?? '',
      category: p.category ?? '',
      inventory: p.inventory_quantity ?? (inStock ? -1 : 0),
      active: true,
      attrs: {},
      created_at: nowMs,
    };
  });
}

export async function importCatalog(
  env: Env,
  brandTenant: string,
  req: ImportRequest,
  nowMs: number,
): Promise<ImportResult> {
  const products = toProducts(brandTenant, req, nowMs);
  const errors: ImportResult['errors'] = [];
  let imported = 0;
  for (const product of products) {
    try {
      await upsertProduct(env, product);
      imported += 1;
    } catch (err) {
      errors.push({ id: product.id, error: (err as Error).message });
    }
  }
  return { imported, errors };
}
