---
name: felix-dev-loop
description: Build/test/typecheck/lint workflow for the Felix orchestrator, including the generated-bundle prerequisite, the two-project vitest layout, and local setup/seeding.
when_to_use: Running tests, fixing typecheck or lint errors, "cannot find module" errors mentioning bundled.ts, adding a binding used by integration tests, fresh repo setup, seeding local data, running a single test, chat-ui example install problems.
---

# Felix dev loop

## The one rule that prevents phantom failures

`packages/core/src/manifests/bundled.ts`, `packages/core/src/skills/bundled.ts`, and `packages/core/src/docs/bundled.ts` are **generated and gitignored**, but imported by the Worker, typecheck, and tests. Run `pnpm build` (= `build:manifests` + `build:docs`) **before** `pnpm typecheck` / `pnpm test` on a fresh clone or after editing `packages/core/manifests/*.yaml`, `packages/core/skills/*/SKILL.md`, or `packages/core/docs/**/*.md`. CI does exactly this. A "cannot find module .../bundled" error means the build never ran — it is not a code bug.

Never edit the `bundled.ts` files directly (a hook blocks this); edit the sources and rebuild.

## Commands

| Task | Command |
|---|---|
| Install (pnpm workspace: packages/core + packages/commerce; root delegates scripts) | `pnpm install` |
| Generate bundles (required before dev/test/typecheck) | `pnpm build` |
| Dev server (runs builds first) | `pnpm dev` |
| All tests | `pnpm test` |
| Single file | `pnpm test -- packages/core/tests/unit/manifest_schema.test.ts` |
| Single test by name | `pnpm test -- --project unit -t "rejects unknown kind"` |
| Typecheck | `pnpm typecheck` |
| Lint / autofix | `pnpm lint` / `pnpm lint:fix` |
| Local D1 migrations | `pnpm migrate:local` |
| Seed demo catalog (re-runnable) | `pnpm --filter @felix/orchestrator exec wrangler d1 execute orchestrator --local --file=scripts/seed-products.sql` (runs in `packages/core/`) |

## Vitest topology (two projects)

- `unit` — node pool, `packages/*/tests/**/*.test.ts` (excluding `packages/core/tests/integration/**`). Pure logic, schema, governance wrappers, fake DOs.
- `workers` — miniflare/workerd, `packages/core/tests/integration/**/*.test.ts`. Bindings are declared **explicitly in `vitest.config.ts` (`miniflare.bindings` block)** — integration tests do NOT read wrangler config.

Adding a binding therefore touches three files: `packages/core/wrangler.example.jsonc` + `packages/core/src/env.ts` + `vitest.config.ts`. Miss the last one and the workers project fails with an undefined binding.

## Local setup gotchas

- `packages/core/wrangler.jsonc` is gitignored (holds account/resource ids): `cp packages/core/wrangler.example.jsonc packages/core/wrangler.jsonc`. Bare `wrangler` commands run from `packages/core/`.
- Local secrets go in `packages/core/.dev.vars` (copy from `packages/core/.dev.vars.example`). Never read `.dev.vars` or `.secrets/` contents.
- `examples/chat-ui` must install with `pnpm install --ignore-workspace` (pnpm 10 workspace-detection gotcha; plain install pulls the root workspace deps instead).
- Versions: pnpm 10, node 22 in CI (`engines >= 20`), biome 2.4.x, vitest 4.

## Naming disambiguation

The `packages/core/skills/` directory holds **Felix runtime skills** (bundled into the Worker by `build:manifests`). It is unrelated to `.claude/skills/` (Claude Code config, where this file lives).
