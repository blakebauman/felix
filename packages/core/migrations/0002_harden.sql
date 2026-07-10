-- Hardening pass: tenant-scope jobs, add next-run index, document
-- known-secret keys we no longer persist in audit/approval payloads.
--
-- Jobs were originally keyed by `name` alone, which let any authenticated
-- caller list/run another tenant's jobs. New PK is (tenant_id, name).
-- SQLite can't ALTER a PRIMARY KEY in place, so we rewrite the table.

CREATE TABLE IF NOT EXISTS jobs_new (
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  schedule        TEXT NOT NULL DEFAULT '',
  manifest_id     TEXT NOT NULL DEFAULT '',
  last_run_at     INTEGER,
  next_run_at     INTEGER,
  last_status     TEXT NOT NULL DEFAULT '',
  last_error      TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, name)
);

INSERT OR IGNORE INTO jobs_new
  (tenant_id, name, schedule, manifest_id, last_run_at, next_run_at,
   last_status, last_error, created_at, payload_json)
SELECT 'default', name, schedule, manifest_id, last_run_at, NULL,
       last_status, last_error, created_at, payload_json
  FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX IF NOT EXISTS idx_jobs_tenant_name ON jobs (tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON jobs (next_run_at)
  WHERE schedule != '' AND next_run_at IS NOT NULL;
