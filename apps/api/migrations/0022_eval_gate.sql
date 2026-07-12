-- Eval activation gate — record which tenant-managed manifest version an
-- eval run actually tested so the /manifests activate + canary routes can
-- gate a version flip on a PASSING run for that exact (tenant, manifest,
-- version).
--
-- `manifest_version` is the resolved tenant-D1 version the runner drove the
-- dataset against. It is NULL for runs whose candidate resolved to a
-- bundled / R2 manifest (no tenant version number) — those can never
-- satisfy the gate, which only guards tenant-managed version pointers.
--
-- Backfilled implicitly: existing rows keep NULL, so the opt-in gate simply
-- has no passing run to point at for pre-migration versions.

ALTER TABLE eval_runs ADD COLUMN manifest_version INTEGER;

-- Gate lookup: given (tenant_id, candidate_manifest, manifest_version) find
-- the newest completed passing run. Tenant-first per the composite-key rule.
CREATE INDEX IF NOT EXISTS idx_eval_runs_gate
  ON eval_runs (tenant_id, candidate_manifest, manifest_version, started_at DESC);
