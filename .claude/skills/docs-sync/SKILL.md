---
name: docs-sync
description: Keep Felix documentation and the OpenAPI spec in sync with code — the code-surface → doc-artifact map, OpenAPI route registration rules, and the verification loop.
when_to_use: 'Requests like "update the docs", "sync the openapi spec", "is the documentation current", "docs drift"; after changing routes, schemas, env vars, audit events, or migrations; when the doc-drift Stop gate fires.'
---

# Docs & OpenAPI sync

The OpenAPI spec is **generated at runtime** by `@hono/zod-openapi`: only routes registered with `createRoute` + `.openapi()` appear in `/openapi.json` and the Scalar UI at `/docs`. A plain `app.get(...)` route is silently invisible — that is the #1 drift bug. Prose docs live in `packages/core/docs/` and are bundled into the Worker by `pnpm build:docs`.

## Code surface → doc artifacts map

| You changed | Update |
|---|---|
| Route in `packages/core/src/api/*.ts` / `packages/core/src/app.ts` | Register via `createRoute` + `.openapi()` (shared pieces: `ErrorBodySchema`, `BearerSecurity()`, pagination in `packages/core/src/api/openapi-shared.ts`; `bearerAuth` component registered in app.ts). Then `packages/core/docs/guide/rest-api.md` (public) or `packages/core/docs/guide/management-api.md` (scoped) — include the required scope. |
| Manifest schema (`packages/core/src/manifests/schema.ts`) | `.openapi({description, example})` on the field, the golden example in `ManifestSchema.openapi({example})`, and `packages/core/docs/guide/manifest-reference.md`. |
| Env var / binding (`packages/core/src/env.ts`) | `packages/core/wrangler.example.jsonc`, `packages/core/.dev.vars.example` (if secret), `vitest.config.ts` miniflare.bindings (if tests need it), `packages/core/docs/guide/deploy.md` + `packages/core/docs/guide/getting-started.md`. |
| Audit event type / metric (`packages/core/src/audit/models.ts`, `packages/core/src/observability/metrics.ts`) | `packages/core/docs/internals/observability.md` catalogs (+ the observability skill's tables in `.claude/skills/observability/SKILL.md`). |
| Migration / table (`packages/core/migrations/*.sql`) | `packages/core/docs/internals/persistence.md` + the CLAUDE.md persistence-layout paragraph. |
| Pattern / model client / session / governance behavior | `packages/core/docs/internals/{patterns,model-client,manifest-pipeline,governance}.md`; architecture facts also live in CLAUDE.md — keep both true. |
| Commerce surface (`packages/commerce/src/**`) | `packages/core/docs/internals/commerce.md`; commerce routes need the same `createRoute` registration to appear in `/openapi.json`. |
| Auth / scopes | `packages/core/docs/internals/auth.md` + the scope catalog in the staging-auth skill. |

CLAUDE.md is always-loaded context: if a change falsifies a sentence in it, fixing CLAUDE.md is part of the change.

## Procedure

1. Diff-driven: `git diff --name-only HEAD` → walk the map above for every hit.
2. Make the doc/OpenAPI edits (delegate bulk drafting to the **felix-docs-writer** subagent for large drifts; review its edits before accepting).
3. `pnpm build:docs` (docs are bundled — stale bundle = stale in-Worker docs site). `pnpm build:manifests` if example YAMLs changed.
4. Verify:
   ```bash
   pnpm test -- packages/core/tests/integration/openapi.test.ts   # 'documents every public path', components, inline field docs
   pnpm test -- packages/core/tests/unit/docs_links.test.ts       # intra-doc links resolve
   pnpm test -- packages/core/tests/unit/manifest_schema.test.ts  # if schema metadata changed
   ```
5. For a live check: `curl -s $BASE/openapi.json | jq '.paths | keys'` against local dev and compare with the routes you touched.

## Writing style for docs

Match the existing docs' voice: dense, factual, present tense, code identifiers in backticks, no marketing prose. `packages/core/docs/guide/` is for operators/integrators (task-oriented); `packages/core/docs/internals/` is for contributors (mechanism-oriented).
