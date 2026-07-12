/**
 * Brand store (Postgres). Brand records are scoped by the operator tenant that
 * owns them — every query includes `WHERE tenant_id = …`. The `brand_tenant`
 * column points at the brand's data tenant (catalog/orders/manifest).
 */

import { getDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';
import { type Brand, BrandIdentity } from './models';

interface BrandRow {
  tenant_id: string;
  id: string;
  brand_tenant: string;
  name: string;
  identity_json: Record<string, unknown> | null;
  status: string;
  created_at: number;
  updated_at: number;
}

function rowToBrand(row: BrandRow): Brand {
  let identity = BrandIdentity.parse({});
  try {
    identity = BrandIdentity.parse(row.identity_json ?? {});
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
  const sql = getDb(env);
  await sql`
    INSERT INTO brands (tenant_id, id, brand_tenant, name, identity_json, status, created_at, updated_at)
      VALUES (${brand.tenant_id}, ${brand.id}, ${brand.brand_tenant}, ${brand.name},
              ${brand.identity as unknown as Record<string, unknown>}, ${brand.status},
              ${brand.created_at}, ${brand.updated_at})
      ON CONFLICT (tenant_id, id) DO UPDATE SET
        brand_tenant = excluded.brand_tenant,
        name = excluded.name,
        identity_json = excluded.identity_json,
        status = excluded.status,
        updated_at = excluded.updated_at
  `;
}

export async function getBrand(env: Env, tenantId: string, id: string): Promise<Brand | null> {
  const sql = getDb(env);
  const rows = await sql<BrandRow[]>`
    SELECT * FROM brands WHERE tenant_id = ${tenantId} AND id = ${id} LIMIT 1
  `;
  return rows[0] ? rowToBrand(rows[0]) : null;
}

export async function listBrands(env: Env, tenantId: string): Promise<Brand[]> {
  const sql = getDb(env);
  const rows = await sql<BrandRow[]>`
    SELECT * FROM brands WHERE tenant_id = ${tenantId} ORDER BY created_at DESC
  `;
  return rows.map(rowToBrand);
}

export async function deleteBrand(env: Env, tenantId: string, id: string): Promise<boolean> {
  const sql = getDb(env);
  const res = await sql`DELETE FROM brands WHERE tenant_id = ${tenantId} AND id = ${id}`;
  return res.count > 0;
}

/**
 * Global lookup by the brand's data tenant (which is globally unique). Used by
 * the public storefront path — there is no operator tenant on a shopper
 * request, so this deliberately omits the operator filter.
 */
export async function getBrandByTenant(env: Env, brandTenant: string): Promise<Brand | null> {
  const sql = getDb(env);
  const rows = await sql<BrandRow[]>`
    SELECT * FROM brands WHERE brand_tenant = ${brandTenant} LIMIT 1
  `;
  return rows[0] ? rowToBrand(rows[0]) : null;
}

/** Register a storefront host → brand mapping (host is the global routing key). */
export async function addDomain(
  env: Env,
  domain: { host: string; brand: Brand },
  nowMs: number,
): Promise<void> {
  const host = domain.host.trim().toLowerCase();
  const sql = getDb(env);
  await sql`
    INSERT INTO brand_domains (host, brand_tenant, brand_id, operator_tenant, created_at)
      VALUES (${host}, ${domain.brand.brand_tenant}, ${domain.brand.id},
              ${domain.brand.tenant_id}, ${nowMs})
      ON CONFLICT (host) DO UPDATE SET
        brand_tenant = excluded.brand_tenant,
        brand_id = excluded.brand_id,
        operator_tenant = excluded.operator_tenant
  `;
}

/** Resolve a brand from a storefront host (public; global lookup). */
export async function getBrandByDomain(env: Env, host: string): Promise<Brand | null> {
  const normalized = host.trim().toLowerCase().split(':')[0] ?? '';
  if (!normalized) return null;
  const sql = getDb(env);
  const rows = await sql<{ brand_tenant: string }[]>`
    SELECT brand_tenant FROM brand_domains WHERE host = ${normalized} LIMIT 1
  `;
  return rows[0] ? getBrandByTenant(env, rows[0].brand_tenant) : null;
}

export async function listDomains(
  env: Env,
  operatorTenant: string,
  brandId: string,
): Promise<string[]> {
  const sql = getDb(env);
  const rows = await sql<{ host: string }[]>`
    SELECT host FROM brand_domains
      WHERE operator_tenant = ${operatorTenant} AND brand_id = ${brandId}
      ORDER BY host
  `;
  return rows.map((r) => r.host);
}
