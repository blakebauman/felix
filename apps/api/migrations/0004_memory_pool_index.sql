-- Supporting index for the consolidation sweep's pool discovery.
--
-- The sweep has to find which (tenant, manifest) memory pools are large enough
-- to be worth reconciling, which means a GROUP BY across ALL tenants — it does
-- not know whose pools it is looking for until the query answers. The existing
-- idx_memvec_scope leads with tenant_id and so cannot serve that query at all,
-- leaving a sequential scan over every row in the table on every cron tick.
-- memory_vectors also carries every commerce product/image embedding, which
-- this query filters out only after reading them.
--
-- Leading with (kind, manifest_id) matches the WHERE clause, and carrying
-- tenant_id lets the grouping and count be answered from the index. Partial on
-- manifest_id <> '' because rows with no owning manifest (products, images)
-- are never agent memory and never a consolidation target.
--
-- This is a deliberate tenant-agnostic sweep index, the same exception
-- idx_audit_ts carves out for the retention sweep.

CREATE INDEX idx_memvec_pools
  ON memory_vectors (kind, manifest_id, tenant_id)
  WHERE manifest_id <> '';
