-- Canary rollouts on manifest_active.
--
-- Today `manifest_active` is one row per (tenant, name) pointing at the
-- stable `version`. This migration adds an optional canary pointer alongside
-- so a tenant can flip a subset of traffic to a candidate version
-- without changing the stable one:
--
--   (tenant_id, name, version=stable_v, canary_version=NULL,  canary_weight=0)
--   (tenant_id, name, version=stable_v, canary_version=candidate_v, canary_weight=25)
--
-- The resolver hashes (tenant_id, thread_id, name, stable_v, canary_v)
-- to bucket each thread; that hash includes both version numbers so a
-- canary version flip re-randomises thread assignment instead of
-- carrying the old buckets forward.
--
-- `canary_weight` is an integer 0–100. 0 disables the canary; 100 routes
-- everything to canary (rare — used by a "promote canary" workflow that
-- swaps stable_v immediately after).
--
-- SQLite can't add a CHECK constraint via ALTER TABLE in versions Felix
-- ships against, so the bounds (0..100) are enforced in the store layer
-- (`setCanary`) rather than at the schema. The migration only adds the
-- columns with safe defaults.

ALTER TABLE manifest_active ADD COLUMN canary_version INTEGER;
ALTER TABLE manifest_active ADD COLUMN canary_weight INTEGER NOT NULL DEFAULT 0;
