-- Initial D1 schema for orchestrator persistence.
-- Mirrors the DynamoDB tables on the AWS side:
--   audit, plans, jobs, approvals, skill_activation.
-- Composite (tenant_id, id) primary keys preserve tenant scoping. Indexes
-- on (tenant_id, ts DESC) replicate DynamoDB's `ScanIndexForward=False`
-- query pattern used by `list_events`, `list_requests`, etc.

CREATE TABLE IF NOT EXISTS audit_events (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  ts              INTEGER NOT NULL,         -- epoch ms
  event_type      TEXT NOT NULL,
  manifest_id     TEXT NOT NULL DEFAULT '',
  principal_subj  TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT '', -- e.g. denied/allowed
  payload_json    TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts ON audit_events (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_status_ts ON audit_events (tenant_id, status, ts DESC);

CREATE TABLE IF NOT EXISTS plans (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  manifest_id     TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER,                  -- TTL — null = no expiry
  plan_json       TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_plans_tenant_updated ON plans (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  name            TEXT PRIMARY KEY,
  schedule        TEXT NOT NULL DEFAULT '',
  manifest_id     TEXT NOT NULL DEFAULT '',
  last_run_at     INTEGER,
  last_status     TEXT NOT NULL DEFAULT '',
  last_error      TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  payload_json    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS approvals (
  id                TEXT NOT NULL,
  tenant_id         TEXT NOT NULL,
  manifest_id       TEXT NOT NULL DEFAULT '',
  tool_name         TEXT NOT NULL,
  call_signature    TEXT NOT NULL,
  args_json         TEXT NOT NULL DEFAULT '{}',
  principal_subj    TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'pending',
  created_at        INTEGER NOT NULL,
  decided_at        INTEGER,
  decided_by        TEXT NOT NULL DEFAULT '',
  decision_note     TEXT NOT NULL DEFAULT '',
  edited_args_json  TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_signature
  ON approvals (tenant_id, manifest_id, tool_name, call_signature);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_status ON approvals (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS skill_activation (
  tenant_id       TEXT NOT NULL,
  manifest_id     TEXT NOT NULL,
  active_skills   TEXT NOT NULL DEFAULT '[]',  -- JSON array of skill names
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, manifest_id)
);

CREATE TABLE IF NOT EXISTS oauth_token_cache (
  cache_key       TEXT PRIMARY KEY,            -- provider:subject
  access_token    TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  scope           TEXT NOT NULL DEFAULT ''
);
