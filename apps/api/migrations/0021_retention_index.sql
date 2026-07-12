-- Indexes supporting the retention / GC sweep (packages/harness/src/jobs/retention.ts).
--
-- The sweep is a GLOBAL (tenant-agnostic) time-window delete, so the existing
-- tenant-first indexes (idx_audit_tenant_ts, idx_plans_tenant_updated) can't
-- serve `WHERE ts < ?` / `WHERE expires_at < ?` without a tenant prefix. These
-- add the single-column indexes the bounded `rowid IN (SELECT ... LIMIT ?)`
-- delete subqueries scan on, keeping each sweep an indexed range delete.

-- audit_events: pruned by absolute ts (< now - AUDIT_RETENTION_DAYS).
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events (ts);

-- plans: pruned by absolute expires_at (< now). Partial index skips the common
-- null-TTL rows so it stays small and only covers deletable rows.
CREATE INDEX IF NOT EXISTS idx_plans_expires ON plans (expires_at) WHERE expires_at IS NOT NULL;
