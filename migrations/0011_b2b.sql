-- Orderloop B2B — accounts + buyers.
--
-- A business `account` (a tenant's customer org) with `buyers` (users in that
-- org, with roles + per-buyer spending limits). Purchases over a buyer's limit
-- route to an approver via the existing approvals pipeline.
--
-- Both entity types are read through the entity data-source seam, so a tenant
-- can keep them native here OR back them with a 3p ERP/procurement system
-- (federated/synced) without changing callers. Native storage lives here.
--
-- Composite (tenant_id, id) primary keys; tenant-scoped indexes.

CREATE TABLE IF NOT EXISTS accounts (
  tenant_id          TEXT NOT NULL,
  id                 TEXT NOT NULL,             -- account id / slug
  name               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active', -- active | suspended
  payment_terms      TEXT NOT NULL DEFAULT 'prepaid', -- prepaid | net15 | net30 | net60
  credit_limit_cents INTEGER NOT NULL DEFAULT 0, -- 0 = no credit line (prepaid)
  currency           TEXT NOT NULL DEFAULT 'usd',
  metadata_json      TEXT NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_accounts_tenant_created
  ON accounts (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS buyers (
  tenant_id            TEXT NOT NULL,
  id                   TEXT NOT NULL,           -- buyer id (subject/email)
  account_id           TEXT NOT NULL,
  email                TEXT NOT NULL DEFAULT '',
  role                 TEXT NOT NULL DEFAULT 'purchaser', -- admin | approver | purchaser | viewer
  spending_limit_cents INTEGER NOT NULL DEFAULT 0, -- 0 = unlimited (subject to account credit)
  status               TEXT NOT NULL DEFAULT 'active', -- active | disabled
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_buyers_tenant_account
  ON buyers (tenant_id, account_id);
