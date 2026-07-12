-- 0019_approvals_ttl.sql
-- Approvals hardening: opt-in TTL, one-shot consumption, principal binding.
--
-- Adds two nullable columns to `approvals`:
--   - ttl_seconds : the matching rule's TTL, stamped at request-creation time so
--                   the DECIDE transition (which only knows tenant + id) can
--                   compute expiry without threading the rule through the route.
--   - expires_at  : computed at DECIDE time as decided_at + ttl_seconds*1000
--                   (ms since epoch). Null = the grant never expires.
--
-- The `status` column is free TEXT, so the two new logical states introduced by
-- this change — `consumed` (a one-shot grant spent on execution) and `expired`
-- (TTL elapsed) — need no DDL. They are terminal, ARCHIVED states: the unique
-- signature index is rewritten as a PARTIAL index over only the live decisions
-- (`pending` / `approved` / `denied`) so a superseded grant no longer blocks a
-- fresh request for the same (tenant, manifest, tool, signature). Live decisions
-- remain unique — at most one active row per signature, preserving the
-- idempotency contract and the sticky-denied behavior.

ALTER TABLE approvals ADD COLUMN ttl_seconds INTEGER;
ALTER TABLE approvals ADD COLUMN expires_at  INTEGER;

DROP INDEX IF EXISTS uq_approval_signature;
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_signature
  ON approvals (tenant_id, manifest_id, tool_name, call_signature)
  WHERE status IN ('pending', 'approved', 'denied');
