---
paths:
  - "packages/commerce/**"
---

# Commerce package boundary rules

- Never relative-import outside `packages/commerce/` — consume harness seams via `@felix/harness/<path-from-src>` package specifiers (TS source exports; no build step). `apps/api/tests/unit/plugin_boundary.test.ts` enforces this.
- The package exports ONE supported symbol: the `FelixPlugin` in `packages/commerce/src/plugin.ts` (contract: `packages/harness/src/plugins/types.ts`). New routes/tools/crons/auth-mounts/rate-limit keys hang off the plugin object — the harness never imports `@felix/commerce`; the only line that names it is `installedPlugins()` in `apps/api/src/composition.ts`.
- Env vars merge via module augmentation in `packages/commerce/src/env.ts` (augments `@felix/harness/env`) — never add commerce vars to `packages/harness/src/env.ts` directly.
- Commerce D1 migrations live in the `apps/api/migrations/` dir with the commerce prefix convention; tenancy rules apply unchanged.
- Commerce routes appear in `/openapi.json` only when registered via `createRoute` + `.openapi()` — same rule as the harness's `packages/harness/src/api/`.
