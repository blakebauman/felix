---
name: docs-sync
description: Keep Felix documentation and the OpenAPI spec in sync with code — the code-surface → doc-artifact map, OpenAPI route registration rules, and the verification loop.
when_to_use: 'Requests like "update the docs", "sync the openapi spec", "is the documentation current", "docs drift"; after changing routes, schemas, env vars, audit events, or migrations; when the doc-drift Stop gate fires.'
---

# Docs & OpenAPI sync

The OpenAPI spec is **generated at runtime** by `@hono/zod-openapi`: only routes registered with `createRoute` + `.openapi()` appear in `/openapi.json` and the Scalar UI at `/docs`. A plain `app.get(...)` route is silently invisible — that is the #1 drift bug. Prose docs live next to the package they document (`packages/harness/docs/`, `packages/commerce/docs/`) and ship as a separate static Starlight site (`apps/docs`, deployed to docs.felix.run via `pnpm docs:deploy`); the Worker only serves 301s from the legacy `/docs/*` prose routes.

## Code surface → doc artifacts map

| You changed | Update |
|---|---|
| Route in `packages/harness/src/api/*.ts` / `packages/harness/src/app.ts` | Register via `createRoute` + `.openapi()` (shared pieces: `ErrorBodySchema`, `BearerSecurity()`, pagination in `packages/harness/src/api/openapi-shared.ts`; `bearerAuth` component registered in app.ts). Then `packages/harness/docs/guide/rest-api.md` (public) or `packages/harness/docs/guide/management-api.md` (scoped) — include the required scope. |
| Manifest schema (`packages/harness/src/manifests/schema.ts`) | `.openapi({description, example})` on the field, the golden example in `ManifestSchema.openapi({example})`, and `packages/harness/docs/guide/manifest-reference.md`. |
| Env var / binding (`packages/harness/src/env.ts`) | `apps/api/wrangler.example.jsonc`, `apps/api/.dev.vars.example` (if secret), `vitest.config.ts` miniflare.bindings (if tests need it), `packages/harness/docs/guide/deploy.md` + `packages/harness/docs/guide/getting-started.md`. |
| Audit event type / metric (`packages/harness/src/audit/models.ts`, `packages/harness/src/observability/metrics.ts`) | `packages/harness/docs/internals/observability.md` catalogs (+ the observability skill's tables in `.claude/skills/observability/SKILL.md`). |
| Migration / table (`apps/api/migrations/*.sql`) | `packages/harness/docs/internals/persistence.md` + the CLAUDE.md persistence-layout paragraph. |
| Pattern / model client / session / governance behavior | `packages/harness/docs/internals/{patterns,model-client,manifest-pipeline,governance}.md`; architecture facts also live in CLAUDE.md — keep both true. |
| Commerce surface (`packages/commerce/src/**`) | `packages/commerce/docs/index.md` (the Commerce section of the docs site); commerce routes need the same `createRoute` registration to appear in `/openapi.json`. |
| Auth / scopes | `packages/harness/docs/internals/auth.md` + the scope catalog in the staging-auth skill. |

CLAUDE.md is always-loaded context: if a change falsifies a sentence in it, fixing CLAUDE.md is part of the change.

## Procedure

1. Diff-driven: `git diff --name-only HEAD` → walk the map above for every hit.
2. Make the doc/OpenAPI edits (delegate bulk drafting to the **felix-docs-writer** subagent for large drifts; review its edits before accepting).
3. `pnpm docs:build` (syncs `packages/*/docs` into the Starlight site and builds it — catches broken frontmatter/links). `pnpm build:manifests` if example YAMLs changed. Prose changes go live via `pnpm docs:deploy`, not the Worker deploy.
4. Verify:
   ```bash
   pnpm test -- apps/api/tests/integration/openapi.test.ts   # 'documents every public path', components, inline field docs
   pnpm test -- apps/api/tests/integration/docs_site.test.ts # legacy /docs/* prose routes 301 to the docs site
   pnpm test -- packages/harness/tests/unit/manifest_schema.test.ts  # if schema metadata changed
   ```
5. For a live check: `curl -s $BASE/openapi.json | jq '.paths | keys'` against local dev and compare with the routes you touched.

## Writing style for docs

Match the existing docs' voice: dense, factual, present tense, code identifiers in backticks, no marketing prose. `packages/harness/docs/guide/` is for operators/integrators (task-oriented); `packages/harness/docs/internals/` is for contributors (mechanism-oriented); `packages/commerce/docs/` documents the commerce layer. Cross-package doc links use repo-relative markdown paths (e.g. `../../commerce/docs/index.md`) — the docs-site sync script maps them to site routes, and they stay browsable on GitHub.
