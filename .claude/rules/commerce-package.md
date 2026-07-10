---
paths:
  - "packages/commerce/**"
---

# Commerce package boundary rules

- Never relative-import outside `packages/commerce/` — consume core seams via `@felix/orchestrator/<path-from-src>` package specifiers (TS source exports; no build step). `packages/core/tests/unit/plugin_boundary.test.ts` enforces this.
- The package exports ONE supported symbol: the `FelixPlugin` in `packages/commerce/src/plugin.ts` (contract: `packages/core/src/plugins/types.ts` in core). New routes/tools/crons/auth-mounts/rate-limit keys hang off the plugin object — core is never edited to know about commerce specifics beyond the single `installedPlugins()` line in `packages/core/src/composition.ts`.
- Env vars merge via module augmentation in `packages/commerce/src/env.ts` (augments `@felix/orchestrator/env`) — never add commerce vars to core `packages/core/src/env.ts` directly.
- Commerce D1 migrations live in the core `packages/core/migrations/` dir with the commerce prefix convention; tenancy rules apply unchanged.
- Commerce routes appear in `/openapi.json` only when registered via `createRoute` + `.openapi()` — same rule as core `packages/core/src/api/`.
