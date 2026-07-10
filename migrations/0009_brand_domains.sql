-- Orderloop D2C — storefront domain routing.
--
-- Maps a public storefront host (custom domain or <slug>.shop.felix.run) to a
-- brand so an anonymous shopper request can be routed to the right brand's
-- agent + catalog (under brand_tenant) without an operator JWT. `host` is the
-- global routing key (one host → one brand), so this is a single-row lookup
-- with no tenant filter — intentional for public serving.

CREATE TABLE IF NOT EXISTS brand_domains (
  host             TEXT NOT NULL,           -- lowercased hostname (no scheme/port)
  brand_tenant     TEXT NOT NULL,           -- brand's data tenant
  brand_id         TEXT NOT NULL,           -- brand slug
  operator_tenant  TEXT NOT NULL,           -- owning operator tenant
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (host)
);
CREATE INDEX IF NOT EXISTS idx_brand_domains_brand_tenant
  ON brand_domains (brand_tenant);
