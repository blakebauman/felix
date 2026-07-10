-- Agentic Commerce Protocol (ACP) — merchant-side checkout sessions.
--
-- Orderloop exposes the ACP merchant endpoints (`/acp/checkout_sessions/*`)
-- so external agents (ChatGPT Instant Checkout, etc.) can transact with our
-- catalog. ACP is single-merchant — every session belongs to our own merchant
-- tenant (env.ACP_MERCHANT_TENANT, default `default`), the same tenant whose
-- `products` / `orders` rows the buyer-side agent uses.
--
-- The full ACP CheckoutSession object is stored as JSON (it's the protocol's
-- own shape, not ours to normalize); status is promoted to a column so the
-- state machine (not_ready_for_payment → ready_for_payment → completed /
-- canceled) is queryable. Composite (tenant_id, id) primary key.

CREATE TABLE IF NOT EXISTS acp_checkout_sessions (
  tenant_id     TEXT NOT NULL,
  id            TEXT NOT NULL,             -- checkout_session id (acp_...)
  status        TEXT NOT NULL,             -- ACP status enum
  session_json  TEXT NOT NULL,             -- full CheckoutSession JSON
  order_id      TEXT NOT NULL DEFAULT '',  -- set once completed
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_acp_sessions_tenant_updated
  ON acp_checkout_sessions (tenant_id, updated_at DESC);
