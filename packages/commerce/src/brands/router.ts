/**
 * D2C brand provisioning + catalog import.
 *
 *   POST   /brands                 → provision a brand (record + per-brand manifest)
 *   GET    /brands                 → list the operator's brands
 *   GET    /brands/:id             → one brand
 *   DELETE /brands/:id             → remove the brand record
 *   POST   /brands/:id/catalog     → import products into the brand's tenant
 *   GET    /brands/:id/catalog     → list the brand's catalog (paginated)
 *
 * Operator-scoped: brand records live under the caller's (operator's) tenant
 * (`auth.principal.tenantId`). Writes require the `brands:write` scope; in dev
 * without verifiers the gate falls open (like `/manifests`). The brand's
 * catalog/orders/manifest live under its own `brand_tenant`.
 *
 * Mounted at `/brands` in `app.ts`.
 */

import { recordEvent } from '@felix/harness/audit/store';
import type { AuthContext } from '@felix/harness/auth/context';
import { requireScope } from '@felix/harness/auth/middleware';
import type { Env } from '@felix/harness/env';
import { Hono } from 'hono';
import { listProductsPage, reindexCatalogEmbeddings } from '../catalog-store';
import { importCatalog } from './import';
import {
  type Brand,
  BrandIdentity,
  CreateBrandRequest,
  ImportRequest,
  RegisterDomainRequest,
  UpdateBrandRequest,
} from './models';
import { provisionBrandManifest } from './provision';
import { addDomain, deleteBrand, getBrand, listBrands, listDomains, upsertBrand } from './store';

const WRITE_SCOPE = 'brands:write';

type Vars = { Variables: { auth: AuthContext } };

function operatorTenant(c: { get: (k: 'auth') => AuthContext }): string {
  return c.get('auth').principal.tenantId;
}

export function buildBrandsRouter(): Hono<{ Bindings: Env } & Vars> {
  const app = new Hono<{ Bindings: Env } & Vars>();

  app.post('/', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const parsed = CreateBrandRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);

    const tenant = operatorTenant(c);
    const existing = await getBrand(c.env, tenant, parsed.data.id);
    if (existing) return c.json({ error: 'brand_exists', id: parsed.data.id }, 409);

    const now = Date.now();
    const brand: Brand = {
      tenant_id: tenant,
      id: parsed.data.id,
      brand_tenant: parsed.data.brand_tenant ?? parsed.data.id,
      name: parsed.data.name,
      identity: BrandIdentity.parse(parsed.data.identity ?? {}),
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    await upsertBrand(c.env, brand);
    const version = await provisionBrandManifest(c.env, brand, c.get('auth').principal.subject);

    recordEvent({
      tenantId: tenant,
      eventType: 'brand_provisioned',
      manifestId: 'orderloop',
      status: 'ok',
      payload: { brand_id: brand.id, brand_tenant: brand.brand_tenant, manifest_version: version },
    });
    return c.json({ brand, manifest: { name: 'orderloop', version } }, 201);
  });

  app.get('/', async (c) => {
    return c.json({ brands: await listBrands(c.env, operatorTenant(c)) }, 200);
  });

  app.get('/:id', async (c) => {
    const brand = await getBrand(c.env, operatorTenant(c), c.req.param('id'));
    if (!brand) return c.json({ error: 'not_found' }, 404);
    return c.json(brand, 200);
  });

  app.patch('/:id', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const tenant = operatorTenant(c);
    const brand = await getBrand(c.env, tenant, c.req.param('id'));
    if (!brand) return c.json({ error: 'not_found' }, 404);
    const parsed = UpdateBrandRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);

    const nextIdentity = parsed.data.identity
      ? BrandIdentity.parse({ ...brand.identity, ...parsed.data.identity })
      : brand.identity;
    const updated: Brand = {
      ...brand,
      name: parsed.data.name ?? brand.name,
      status: parsed.data.status ?? brand.status,
      identity: nextIdentity,
      updated_at: Date.now(),
    };
    await upsertBrand(c.env, updated);

    // Re-provision the branded manifest when the voice/name changed so the
    // agent's system prompt stays in sync.
    const voiceChanged =
      updated.name !== brand.name ||
      JSON.stringify(updated.identity) !== JSON.stringify(brand.identity);
    let manifestVersion: number | undefined;
    if (voiceChanged) {
      manifestVersion = await provisionBrandManifest(
        c.env,
        updated,
        c.get('auth').principal.subject,
      );
    }
    return c.json(
      { brand: updated, ...(manifestVersion ? { manifest_version: manifestVersion } : {}) },
      200,
    );
  });

  app.delete('/:id', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const ok = await deleteBrand(c.env, operatorTenant(c), c.req.param('id'));
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true }, 200);
  });

  app.post('/:id/catalog', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const brand = await getBrand(c.env, operatorTenant(c), c.req.param('id'));
    if (!brand) return c.json({ error: 'not_found' }, 404);
    const parsed = ImportRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);

    const result = await importCatalog(c.env, brand.brand_tenant, parsed.data, Date.now());
    recordEvent({
      tenantId: operatorTenant(c),
      eventType: 'brand_catalog_import',
      manifestId: 'orderloop',
      status: result.errors.length ? 'partial' : 'ok',
      payload: { brand_id: brand.id, imported: result.imported, errors: result.errors.length },
    });
    return c.json(result, 200);
  });

  // Backfill embeddings for a brand's existing catalog (text + image vectors).
  // Needed for catalogs imported before the embedding hook, or after enabling
  // Vectorize metadata indexes. Idempotent.
  app.post('/:id/reindex', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const brand = await getBrand(c.env, operatorTenant(c), c.req.param('id'));
    if (!brand) return c.json({ error: 'not_found' }, 404);
    const processed = await reindexCatalogEmbeddings(c.env, brand.brand_tenant);
    return c.json({ ok: true, reindexed: processed }, 200);
  });

  app.post('/:id/domains', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const brand = await getBrand(c.env, operatorTenant(c), c.req.param('id'));
    if (!brand) return c.json({ error: 'not_found' }, 404);
    const parsed = RegisterDomainRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
    await addDomain(c.env, { host: parsed.data.host, brand }, Date.now());
    return c.json({ ok: true, host: parsed.data.host.toLowerCase() }, 201);
  });

  app.get('/:id/domains', async (c) => {
    const brand = await getBrand(c.env, operatorTenant(c), c.req.param('id'));
    if (!brand) return c.json({ error: 'not_found' }, 404);
    return c.json({ hosts: await listDomains(c.env, operatorTenant(c), brand.id) }, 200);
  });

  app.get('/:id/catalog', async (c) => {
    const brand = await getBrand(c.env, operatorTenant(c), c.req.param('id'));
    if (!brand) return c.json({ error: 'not_found' }, 404);
    const limit = Number.parseInt(c.req.query('limit') ?? '50', 10);
    const offset = Number.parseInt(c.req.query('offset') ?? '0', 10);
    const page = await listProductsPage(c.env, brand.brand_tenant, {
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return c.json(page, 200);
  });

  return app;
}
