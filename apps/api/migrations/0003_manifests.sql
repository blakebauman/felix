-- Tenant-managed manifests.
--
-- Tenants get private manifests *and* per-tenant overrides of bundled
-- names. Storage is append-only: every POST inserts a new (tenant_id, name,
-- version) row and updates the manifest_active pointer in the same batch,
-- so rollback is a pointer flip rather than a content rewrite.
--
-- Resolution chain at request time (see src/manifests/resolver.ts):
--   1. tenant D1 active version (this table + manifest_active)
--   2. tenant R2 override at  manifests/<tenant_id>/<name>.json
--   3. global R2 override at  manifests/<name>.json
--   4. BUNDLED_MANIFESTS[name]

CREATE TABLE IF NOT EXISTS manifests (
  tenant_id      TEXT NOT NULL,
  name           TEXT NOT NULL,             -- manifest.metadata.name
  version        INTEGER NOT NULL,          -- monotonic per (tenant_id, name)
  manifest_json  TEXT NOT NULL,             -- full Manifest JSON
  created_at     INTEGER NOT NULL,
  created_by     TEXT NOT NULL DEFAULT '',  -- principal.subject
  comment        TEXT NOT NULL DEFAULT '',  -- optional release note
  PRIMARY KEY (tenant_id, name, version)
);
CREATE INDEX IF NOT EXISTS idx_manifests_tenant_name_created
  ON manifests (tenant_id, name, created_at DESC);

CREATE TABLE IF NOT EXISTS manifest_active (
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_manifest_active_tenant_updated
  ON manifest_active (tenant_id, updated_at DESC);
