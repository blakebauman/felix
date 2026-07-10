-- Consent + attribution seam for agent-mediated purchases.
--
-- `consents` is an append-only log of buyer consent (terms / data-share /
-- marketing) captured at checkout. A withdrawal is a new row with granted = 0,
-- never an update — the history is the audit trail. `order_attribution` records
-- which agent / channel / thread drove each order so a brand keeps the customer
-- relationship the AI shopper would otherwise erase. 1:1 with `orders`.
--
-- Composite (tenant_id, id) primary keys; tenant-scoped indexes.

CREATE TABLE IF NOT EXISTS consents (
  tenant_id     TEXT NOT NULL,
  id            TEXT NOT NULL,
  subject       TEXT NOT NULL DEFAULT '',   -- buyer principal / email
  thread_id     TEXT NOT NULL DEFAULT '',   -- conversation the consent was given in
  channel       TEXT NOT NULL DEFAULT '',   -- chat | acp | b2b | widget
  scopes_json   TEXT NOT NULL DEFAULT '[]', -- e.g. ["terms","data_share","marketing"]
  granted       INTEGER NOT NULL DEFAULT 0, -- 0/1
  terms_version TEXT NOT NULL DEFAULT '',
  policy_url    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_consents_thread
  ON consents (tenant_id, thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consents_subject
  ON consents (tenant_id, subject, created_at DESC);

CREATE TABLE IF NOT EXISTS order_attribution (
  tenant_id     TEXT NOT NULL,
  order_id      TEXT NOT NULL,
  channel       TEXT NOT NULL DEFAULT '',   -- chat | acp | b2b | widget
  manifest_id   TEXT NOT NULL DEFAULT '',
  thread_id     TEXT NOT NULL DEFAULT '',
  buyer_subject TEXT NOT NULL DEFAULT '',
  consent_id    TEXT NOT NULL DEFAULT '',
  utm_json      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_attribution_channel
  ON order_attribution (tenant_id, channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attribution_manifest
  ON order_attribution (tenant_id, manifest_id, created_at DESC);
