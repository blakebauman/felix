-- Orderloop B2B — account/contract pricing.
--
-- Per (account, product), a negotiated price with optional volume tiers
-- (price breaks). The effective unit price for a quote line is the tier with
-- the highest `min_qty` <= line quantity. Quote pricing consults this before
-- falling back to an account-level discount (account.metadata.discount_bps)
-- and then the catalog price.
--
-- Tiers are stored as JSON: [{ "min_qty": 1, "unit_price_cents": 900 }, …].
-- Composite (tenant_id, account_id, product_id) primary key.

CREATE TABLE IF NOT EXISTS contract_prices (
  tenant_id   TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'usd',
  tiers_json  TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_contract_prices_tenant_account
  ON contract_prices (tenant_id, account_id);
