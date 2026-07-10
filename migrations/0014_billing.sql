-- Orderloop B2B — billing provider seam.
--
-- Net-terms invoice collection is virtualized behind a payment-provider seam
-- so we're not locked to Stripe. `billing_settings` records the chosen provider
-- per tenant (default `internal` = manual mark-paid). Each invoice records
-- which provider issued it + the external ref + hosted payment URL.

CREATE TABLE IF NOT EXISTS billing_settings (
  tenant_id    TEXT NOT NULL,
  provider     TEXT NOT NULL DEFAULT 'internal', -- internal | stripe | …
  config_json  TEXT NOT NULL DEFAULT '{}',
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id)
);

ALTER TABLE invoices ADD COLUMN provider TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE invoices ADD COLUMN external_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN hosted_url TEXT NOT NULL DEFAULT '';
