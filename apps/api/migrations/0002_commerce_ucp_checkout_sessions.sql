-- UCP (Universal Commerce Protocol) checkout sessions — sibling of
-- acp_checkout_sessions with its own table so the two protocols' status enums
-- and lifecycles never mix. Tenant-first composite PK per repo convention.

CREATE TABLE ucp_checkout_sessions (
  tenant_id     text NOT NULL,
  id            text NOT NULL,                -- checkout session id (ucp_...)
  status        text NOT NULL,                -- UCP status enum
  session_json  jsonb NOT NULL,               -- full CheckoutSession JSON
  order_id      text NOT NULL DEFAULT '',
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_ucp_sessions_tenant_updated
  ON ucp_checkout_sessions (tenant_id, updated_at DESC);
