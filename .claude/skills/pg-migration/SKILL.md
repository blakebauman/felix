---
name: pg-migration
description: Conventions and checklist for new Postgres migrations in the Felix orchestrator — tenant-first composite PKs, sequential numbering, node-pg-migrate, deploy ordering.
when_to_use: 'Requests like "new migration", "add a table", "alter table"; Postgres schema changes, apps/api/migrations/*.sql edits, tenant isolation, composite primary keys.'
---

# Postgres migrations

Migrations are plain SQL files run by **node-pg-migrate** over a DIRECT (unpooled) Neon connection — never through Hyperdrive (transaction pooling + caching are wrong for DDL), never via wrangler. Applied-state lives in the `pgmigrations` table.

## Conventions (non-negotiable)

- **File**: `apps/api/migrations/NNNN_<slug>.sql`, zero-padded 4-digit, next sequential number — always check `ls apps/api/migrations/` first (do not trust a remembered head). `0001_baseline.sql` is the collapsed post-D1-migration baseline.
- **Plugin tables** (commerce etc.) still live in the `apps/api/migrations/` dir, prefixed with the owning plugin (`NNNN_commerce_*` style per CLAUDE.md).
- **Tenant-first composite PK**: `PRIMARY KEY (tenant_id, id)` in the common case; natural composites where they fit (`(tenant_id, name, version)` for manifests, `(tenant_id, thread_id)` for carts). Every read must be scoped `WHERE tenant_id = ...`. Precedent for why: the old `0002_harden.sql` rewrote `jobs` to `(tenant_id, name)` to close a cross-tenant leak.
- **Indexes**: tenant-scoped — `(tenant_id, ts DESC)` for time-series reads, `(tenant_id, <filter cols>)` otherwise. Tenant-agnostic single-column indexes only for global sweeps (see `idx_audit_ts` / `idx_plans_expires` in the baseline).
- **Types**: booleans as `BOOLEAN`; timestamps as `BIGINT` epoch ms (the getDb client parses int8 → Number); JSON as `JSONB DEFAULT '{}'::jsonb`. Postgres can `ALTER TABLE` in place — no SQLite-style table rebuilds.

## Apply

```bash
pnpm db:up                # local Docker Postgres (pgvector/pgvector:pg17)
pnpm migrate:local        # node-pg-migrate against localhost/felix — ALWAYS run after creating the file
DATABASE_URL=<staging direct url> pnpm migrate:staging      # ask-gated; operator-held Neon DIRECT url (no -pooler)
DATABASE_URL=<prod direct url>    pnpm migrate:production   # ask-gated
```

The vitest workers project applies migrations itself (globalSetup resets `felix_test` and runs node-pg-migrate) — no manual step for tests.

## Deploy-ordering warning

Migrations apply to the target env **before** deploying code that needs them (see /deploy-runbook). An unapplied production migration makes the manifest resolver throw → 404 `unknown_manifest` for ALL manifests — the whole API looks down.

## Tests

- `apps/api/tests/integration/cross_tenant.test.ts` guards tenant isolation — add coverage for the new table (row written under tenant A must be invisible to tenant B).
- Integration tests get the fresh schema from globalSetup automatically; if the table's queries need a new binding, remember the `miniflare` block in `vitest.config.ts`.
