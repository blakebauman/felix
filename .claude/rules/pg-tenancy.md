---
paths:
  - "apps/api/migrations/**/*.sql"
  - "packages/harness/src/**/store.ts"
  - "packages/harness/src/**/*store*.ts"
  - "packages/commerce/src/**/store*.ts"
  - "packages/harness/src/db/**"
---

# Postgres tenancy rules

- Every table: tenant-first composite PK — `PRIMARY KEY (tenant_id, id)` or a natural composite starting with `tenant_id`. Every index starts with `tenant_id` (`(tenant_id, ts DESC)` for time-series); tenant-agnostic sweep indexes (retention) are the documented exception.
- Every query: `WHERE tenant_id = ${...}` with the tenant taken from the authenticated `RequestContext` — never from user-supplied body/query params.
- postgres.js tagged templates only (`sql`...${v}...``) via `getDb(env)`; never string-interpolate SQL. Multi-statement writes use `sql.begin(async (tx) => ...)`; uniform bulk inserts use one multi-row `${sql(rows)}`.
- jsonb params are passed as RAW objects/arrays — never `JSON.stringify` (postgres.js Describes the statement and serializes once; pre-stringifying double-encodes into a jsonb string scalar). Reads come back parsed.
- Types: booleans are real `BOOLEAN`; timestamps `BIGINT` epoch ms (the client parses int8 → Number); JSON `JSONB DEFAULT '{}'::jsonb`. Row-count control flow reads `result.count`.
- Migrations: `apps/api/migrations/NNNN_slug.sql` (node-pg-migrate), next sequential number (check `ls apps/api/migrations/`), plugin-prefixed names for plugin tables; run `pnpm migrate:local` after creating (Docker pg must be up: `pnpm db:up`). New tables need `apps/api/tests/integration/cross_tenant.test.ts` coverage and a `packages/harness/docs/internals/persistence.md` + CLAUDE.md persistence-layout update.
