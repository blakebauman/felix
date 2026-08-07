-- Supporting index for reading one job's fire history.
--
-- `listJobRuns` answers "how did this scheduled task's recent runs go" from the
-- `job_run` audit rows the sweep already writes, rather than a second table
-- that would duplicate them and need its own retention policy. The query is
--
--   WHERE tenant_id = $1 AND event_type = 'job_run' AND payload_json->>'job' = $2
--   ORDER BY ts DESC LIMIT $3
--
-- and the existing (tenant_id, ts DESC) index makes Postgres walk the tenant's
-- whole audit history newest-first, filtering as it goes. A tenant with heavy
-- tool_call volume and a sparse job could scan a large share of up to
-- AUDIT_RETENTION_DAYS (default 90) of rows to return twenty.
--
-- Leading with (tenant_id, event_type) skips straight to the job_run rows; ts
-- DESC then satisfies the ordering without a sort. The jsonb job-name filter
-- stays a cheap recheck over a set that is already small.

CREATE INDEX idx_audit_tenant_type_ts
  ON audit_events (tenant_id, event_type, ts DESC);
