-- Entity data-source seam.
--
-- Any entity type (account, buyer, product, brand, …) can be backed by a
-- configurable source instead of being hardwired to native D1. Per tenant per
-- entity type, `data_sources` records the mode and (for external modes) the
-- connector config:
--   native    — D1 is the source of truth (default; no row needed)
--   federated — read-through to a 3p connector live (external owns the data)
--   synced    — D1 serves, populated by a pull job / webhook push from a 3p source
--
-- `connector_json` holds `{ kind: 'http'|'mcp', url, auth?, ... }`. Composite
-- (tenant_id, entity_type) primary key.

CREATE TABLE IF NOT EXISTS data_sources (
  tenant_id      TEXT NOT NULL,
  entity_type    TEXT NOT NULL,            -- 'account' | 'buyer' | 'product' | …
  mode           TEXT NOT NULL DEFAULT 'native',
  connector_json TEXT NOT NULL DEFAULT '{}',
  updated_at     INTEGER NOT NULL,
  updated_by     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, entity_type)
);
