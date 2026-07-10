-- Orderloop D2C — per-brand storefronts.
--
-- A platform operator provisions brands. Each `brands` row is owned by the
-- operator's tenant (tenant_id) and points at the brand's own data tenant
-- (`brand_tenant`) under which that brand's catalog (`products`), orders, and
-- per-brand `orderloop` manifest live. Provisioning writes a tenant manifest
-- under `brand_tenant` via the existing manifests store, so
-- resolveManifest(brand_tenant, 'orderloop') returns the branded agent.
--
-- Composite (tenant_id, id) primary key — `id` is the brand slug, unique
-- within the operator tenant. `brand_tenant` is globally unique (defaults to
-- the slug) so brand data never collides across operators.

CREATE TABLE IF NOT EXISTS brands (
  tenant_id     TEXT NOT NULL,             -- operator/platform tenant (owner)
  id            TEXT NOT NULL,             -- brand slug
  brand_tenant  TEXT NOT NULL,             -- data tenant for catalog/orders/manifest
  name          TEXT NOT NULL,
  identity_json TEXT NOT NULL DEFAULT '{}',-- greeting, theme, logo_url, support_email, prompt_extra
  status        TEXT NOT NULL DEFAULT 'active', -- active | disabled
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_brands_tenant_created
  ON brands (tenant_id, created_at DESC);
-- Look a brand up by its data tenant (e.g. when serving a storefront request).
CREATE INDEX IF NOT EXISTS idx_brands_brand_tenant
  ON brands (brand_tenant);
