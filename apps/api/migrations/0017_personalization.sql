-- Predictive personalization — customer identity, behavioral events, and
-- abandoned-cart bookkeeping.
--
-- `customers` gives a stable shopper identity that spans sessions;
-- `customer_sessions` links a conversation thread to a customer (the cart and
-- chat are otherwise anonymous). `behavior_events` is an append-only stream of
-- shopping signals (view / add_to_cart / ...) used both to seed recommendations
-- and to detect abandoned carts. `abandoned_carts` is cron dedup state so a
-- given idle cart fires a recovery signal once.
--
-- Composite (tenant_id, id) primary keys; tenant-scoped indexes.

CREATE TABLE IF NOT EXISTS customers (
  tenant_id    TEXT NOT NULL,
  id           TEXT NOT NULL,             -- stable customer id
  email        TEXT NOT NULL DEFAULT '',
  external_ref TEXT NOT NULL DEFAULT '',  -- id in a 3p CRM / loyalty system
  attrs_json   TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_email
  ON customers (tenant_id, email);

CREATE TABLE IF NOT EXISTS customer_sessions (
  tenant_id   TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer
  ON customer_sessions (tenant_id, customer_id);

CREATE TABLE IF NOT EXISTS behavior_events (
  tenant_id    TEXT NOT NULL,
  id           TEXT NOT NULL,
  customer_id  TEXT NOT NULL DEFAULT '',
  thread_id    TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL,             -- view | add_to_cart | remove | checkout_start | purchase
  product_id   TEXT NOT NULL DEFAULT '',
  ts           INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_behavior_tenant_ts
  ON behavior_events (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_behavior_tenant_thread_ts
  ON behavior_events (tenant_id, thread_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_behavior_tenant_customer_ts
  ON behavior_events (tenant_id, customer_id, ts DESC);

CREATE TABLE IF NOT EXISTS abandoned_carts (
  tenant_id   TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  detected_at INTEGER NOT NULL,
  notified_at INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'open', -- open | recovered | dismissed
  PRIMARY KEY (tenant_id, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_abandoned_tenant_detected
  ON abandoned_carts (tenant_id, detected_at DESC);
