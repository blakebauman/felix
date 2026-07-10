---
name: d1-migration
description: Conventions and checklist for new D1 migrations in the Felix orchestrator — tenant-first composite PKs, sequential numbering, local apply, deploy ordering.
when_to_use: 'Requests like "new migration", "add a table", "alter table"; D1 schema changes, packages/core/migrations/*.sql edits, tenant isolation, composite primary keys.'
---

# D1 migrations

## Conventions (non-negotiable)

- **File**: `packages/core/migrations/NNNN_<slug>.sql`, zero-padded 4-digit, next sequential number — always check `ls packages/core/migrations/` first (do not trust a remembered head).
- **Plugin tables** (commerce etc.) still live in the core `packages/core/migrations/` dir, prefixed with the owning plugin (`NNNN_commerce_*` style per CLAUDE.md).
- **Tenant-first composite PK**: `PRIMARY KEY (tenant_id, id)` in the common case; natural composites where they fit (`(tenant_id, name, version)` for manifests, `(tenant_id, thread_id)` for carts). Every read must be scoped `WHERE tenant_id = ?`. Precedent for why: `0002_harden.sql` rewrote `jobs` to `(tenant_id, name)` to close a cross-tenant leak.
- **Indexes**: tenant-scoped — `(tenant_id, ts DESC)` for time-series reads, `(tenant_id, <filter cols>)` otherwise.
- **Types**: booleans as `INTEGER DEFAULT 0/1`; timestamps as `INTEGER` epoch ms; JSON blobs as `TEXT DEFAULT '{}'`.

## Apply

```bash
pnpm migrate:local        # local SQLite — ALWAYS run after creating the file
pnpm migrate:staging      # remote, orchestrator-staging (ask-gated)
pnpm migrate:production   # remote, orchestrator-prod (ask-gated)
```

## Deploy-ordering warning

Migrations apply to the target env **before** deploying code that needs them (see /deploy-runbook). An unapplied production migration makes the manifest resolver throw → 404 `unknown_manifest` for ALL manifests — the whole API looks down.

## Tests

- `packages/core/tests/integration/cross_tenant.test.ts` guards tenant isolation — add coverage for the new table (row written under tenant A must be invisible to tenant B).
- Integration tests apply migrations via `packages/core/tests/integration/setup.ts` automatically; if the table's queries need a new binding, remember `vitest.config.ts` `miniflare.bindings`.
