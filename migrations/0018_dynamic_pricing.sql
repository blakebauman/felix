-- Dynamic pricing + competitor signals.
--
-- `pricing_rules` are declarative list-price adjustments (basis points, +surge
-- or -discount) scoped to the whole catalog, a category, or one product, gated
-- by a kind (time-of-day / inventory-velocity / competitor-match) with floor and
-- ceiling clamps in `config_json`. `competitor_prices` is observed competitor
-- pricing per product (one row per source); it backs the `competitor_price`
-- entity type, so a tenant can keep it native here OR federate a price feed via
-- the data-source seam.
--
-- Composite (tenant_id, id) primary keys; tenant-scoped indexes.

CREATE TABLE IF NOT EXISTS pricing_rules (
  tenant_id      TEXT NOT NULL,
  id             TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'catalog', -- catalog | category | product
  target         TEXT NOT NULL DEFAULT '',        -- category name or product id ('' for catalog)
  kind           TEXT NOT NULL,                    -- time | velocity | competitor
  adjustment_bps INTEGER NOT NULL DEFAULT 0,       -- +surge / -discount, basis points
  config_json    TEXT NOT NULL DEFAULT '{}',       -- floor_cents, ceiling_cents, start_hour, end_hour, velocity_threshold
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_pricing_rules_tenant_active
  ON pricing_rules (tenant_id, active);

CREATE TABLE IF NOT EXISTS competitor_prices (
  tenant_id   TEXT NOT NULL,
  id          TEXT NOT NULL,             -- e.g. "<product_id>:<source>"
  product_id  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT '',  -- competitor / feed name
  price_cents INTEGER NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'usd',
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_competitor_prices_tenant_product
  ON competitor_prices (tenant_id, product_id);
