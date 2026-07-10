---
paths:
  - "packages/core/migrations/**/*.sql"
  - "packages/core/src/**/store.ts"
  - "packages/core/src/**/*store*.ts"
  - "packages/commerce/src/**/store*.ts"
---

# D1 tenancy rules

- Every table: tenant-first composite PK — `PRIMARY KEY (tenant_id, id)` or a natural composite starting with `tenant_id`. Every index starts with `tenant_id` (`(tenant_id, ts DESC)` for time-series).
- Every query: `WHERE tenant_id = ?` with the tenant taken from the authenticated `RequestContext` — never from user-supplied body/query params.
- Prepared statements only (`DB.prepare(...).bind(...)`); never string-interpolate SQL. Batch multi-row writes with `DB.batch()`.
- Types: booleans `INTEGER DEFAULT 0/1`, timestamps `INTEGER` epoch ms, JSON `TEXT DEFAULT '{}'`.
- Migrations: `packages/core/migrations/NNNN_slug.sql`, next sequential number (check `ls packages/core/migrations/`), plugin-prefixed names for plugin tables; run `pnpm migrate:local` after creating. New tables need `packages/core/tests/integration/cross_tenant.test.ts` coverage and a `packages/core/docs/internals/persistence.md` + CLAUDE.md persistence-layout update.
