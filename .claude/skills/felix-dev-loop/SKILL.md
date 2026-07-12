---
name: felix-dev-loop
description: Build/test/typecheck/lint workflow for the Felix orchestrator, including the generated-bundle prerequisite, the two-project vitest layout, and local setup/seeding.
when_to_use: Running tests, fixing typecheck or lint errors, "cannot find module" errors mentioning bundled.ts, adding a binding used by integration tests, fresh repo setup, seeding local data, running a single test, chat-ui install problems.
---

# Felix dev loop

## The one rule that prevents phantom failures

`packages/harness/src/manifests/bundled.ts` and `packages/harness/src/skills/bundled.ts` are **generated and gitignored**, but imported by the Worker, typecheck, and tests. Run `pnpm build` (= `turbo run build`, which runs `build:manifests`) **before** `pnpm typecheck` / `pnpm test` on a fresh clone or after editing `packages/harness/manifests/*.yaml` or `packages/harness/skills/*/SKILL.md`. CI does exactly this. A "cannot find module .../bundled" error means the build never ran — it is not a code bug. (Prose docs are NOT bundled — they ship as the separate `apps/docs` Starlight site via `pnpm docs:build` / `docs:deploy`.)

Never edit the `bundled.ts` files directly (a hook blocks this); edit the sources and rebuild.

## Commands

| Task | Command |
|---|---|
| Install (pnpm workspace: apps/{api,chat-ui,docs} + packages/{harness,commerce,design}; root delegates scripts) | `pnpm install` |
| Generate bundles (required before dev/test/typecheck) | `pnpm build` |
| Dev server (runs builds first) | `pnpm dev` |
| All tests | `pnpm test` |
| Single file | `pnpm test -- packages/harness/tests/unit/manifest_schema.test.ts` |
| Single test by name | `pnpm test -- --project unit -t "rejects unknown kind"` |
| Typecheck | `pnpm typecheck` |
| Lint / autofix | `pnpm lint` / `pnpm lint:fix` |
| Local Postgres up + migrations | `pnpm db:up && pnpm migrate:local` |
| Seed demo catalog (re-runnable) | `docker exec -i felix-pg psql -U postgres -d felix < packages/harness/scripts/seed-products.sql` |

## Vitest topology (two projects)

- `unit` — node pool, `packages/*/tests/**/*.test.ts` + `apps/*/tests/**/*.test.ts` (excluding `apps/api/tests/integration/**`). Pure logic, schema, governance wrappers, fake DOs, the plugin-boundary guard.
- `workers` — miniflare/workerd, `apps/api/tests/integration/**/*.test.ts` booted through `apps/api/src/index.ts`. Bindings are declared **explicitly in `vitest.config.ts` (`miniflare.bindings` block)** — integration tests do NOT read wrangler config.

Adding a binding therefore touches three files: `apps/api/wrangler.example.jsonc` + `packages/harness/src/env.ts` + `vitest.config.ts`. Miss the last one and the workers project fails with an undefined binding.

## Local setup gotchas

- `apps/api/wrangler.jsonc` is gitignored (holds account/resource ids): `cp apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc`. Bare `wrangler` commands run from `apps/api/`.
- Local secrets go in `apps/api/.dev.vars` (copy from `apps/api/.dev.vars.example`). Never read `.dev.vars` or `.secrets/` contents.
- `apps/chat-ui` is a workspace app — the root `pnpm install` covers it (the old `--ignore-workspace` gotcha is gone); `pnpm chat:dev` / `pnpm chat:deploy` from the root.
- Versions: pnpm 10, node 22 in CI (`engines >= 20`), biome 2.4.x, vitest 4.

## Naming disambiguation

The `packages/harness/skills/` directory holds **Felix runtime skills** (bundled into the Worker by `build:manifests`). It is unrelated to `.claude/skills/` (Claude Code config, where this file lives).
