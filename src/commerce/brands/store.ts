/**
 * Brand store (D1). Brand records are scoped by the operator tenant that owns
 * them — every query includes `WHERE tenant_id = ?`. The `brand_tenant` column
 * points at the brand's data tenant (catalog/orders/manifest).
 */

import type { Env } from '../../env';
import { type Brand, BrandIdentity } from './models';

interface BrandRow {
  tenant_id: string;
  id: string;
  brand_tenant: string;
  name: string;
  identity_json: string;
  status: string;
  created_at: number;
  updated_at: number;
}

function rowToBrand(row: BrandRow): Brand {
  let identity = BrandIdentity.parse({});
  try {
    identity = BrandIdentity.parse(JSON.parse(row.identity_json));
  } catch {
    /* fall back to defaults */
  }
  return {
    tenant_id: row.tenant_id,
    id: row.id,
    brand_tenant: row.brand_tenant,
    name: row.name,
    identity,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function upsertBrand(env: Env, brand: Brand): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO brands (tenant_id, id, brand_tenant, name, identity_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       brand_tenant = excluded.brand_tenant,
       name = excluded.name,
       identity_json = excluded.identity_json,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  )
    .bind(
      brand.tenant_id,
      brand.id,
      brand.brand_tenant,
      brand.name,
      JSON.stringify(brand.identity),
      brand.status,
      brand.created_at,
      brand.updated_at,
    )
    .run();
}

export async function getBrand(env: Env, tenantId: string, id: string): Promise<Brand | null> {
  const row = await env.DB.prepare('SELECT * FROM brands WHERE tenant_id = ? AND id = ? LIMIT 1')
    .bind(tenantId, id)
    .first<BrandRow>();
  return row ? rowToBrand(row) : null;
}

export async function listBrands(env: Env, tenantId: string): Promise<Brand[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM brands WHERE tenant_id = ? ORDER BY created_at DESC',
  )
    .bind(tenantId)
    .all<BrandRow>();
  return (rows.results ?? []).map(rowToBrand);
}

export async function deleteBrand(env: Env, tenantId: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM brands WHERE tenant_id = ? AND id = ?')
    .bind(tenantId, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Global lookup by the brand's data tenant (which is globally unique). Used by
 * the public storefront path — there is no operator tenant on a shopper
 * request, so this deliberately omits the operator filter.
 */
export async function getBrandByTenant(env: Env, brandTenant: string): Promise<Brand | null> {
  const row = await env.DB.prepare('SELECT * FROM brands WHERE brand_tenant = ? LIMIT 1')
    .bind(brandTenant)
    .first<BrandRow>();
  return row ? rowToBrand(row) : null;
}

/** Register a storefront host → brand mapping (host is the global routing key). */
export async function addDomain(
  env: Env,
  domain: { host: string; brand: Brand },
  nowMs: number,
): Promise<void> {
  const host = domain.host.trim().toLowerCase();
  await env.DB.prepare(
    `INSERT INTO brand_domains (host, brand_tenant, brand_id, operator_tenant, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (host) DO UPDATE SET
       brand_tenant = excluded.brand_tenant,
       brand_id = excluded.brand_id,
       operator_tenant = excluded.operator_tenant`,
  )
    .bind(host, domain.brand.brand_tenant, domain.brand.id, domain.brand.tenant_id, nowMs)
    .run();
}

/** Resolve a brand from a storefront host (public; global lookup). */
export async function getBrandByDomain(env: Env, host: string): Promise<Brand | null> {
  const normalized = host.trim().toLowerCase().split(':')[0] ?? '';
  if (!normalized) return null;
  const row = await env.DB.prepare('SELECT brand_tenant FROM brand_domains WHERE host = ? LIMIT 1')
    .bind(normalized)
    .first<{ brand_tenant: string }>();
  return row ? getBrandByTenant(env, row.brand_tenant) : null;
}

export async function listDomains(
  env: Env,
  operatorTenant: string,
  brandId: string,
): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT host FROM brand_domains WHERE operator_tenant = ? AND brand_id = ? ORDER BY host',
  )
    .bind(operatorTenant, brandId)
    .all<{ host: string }>();
  return (rows.results ?? []).map((r) => r.host);
}
