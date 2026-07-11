---
paths:
  - "packages/harness/src/api/**/*.ts"
  - "packages/harness/src/app.ts"
---

# API route rules

- Every route must be registered via `createRoute` + `.openapi()` or it will be invisible in `/openapi.json` and the Scalar UI. Reuse `ErrorBodySchema`, `BearerSecurity()`, and the pagination helpers from `packages/harness/src/api/openapi-shared.ts`.
- Every management route is scope-gated: `requireScope('<surface>:<verb>')` from the auth middleware, and the scope goes in the route's OpenAPI `security` + description. The gate falls open only in dev with no verifiers — never add another bypass.
- Error envelope: `{ error, detail? }` (`ErrorBodySchema`) for management surfaces; the OpenAI-compat router keeps its own `{ error: { message } }` shape — don't unify them.
- Request-path manifest lookups use `resolveManifest(env, tenantId, name)`, never the sync `loadManifest`.
- Throw `HTTPException` for expected failures; anything else hits `app.onError` (500 + `unhandled_error` audit). Audit from error paths outside request context uses `recordEventDetached(env, opts, execCtx)`.
- New route ⇒ update `packages/harness/docs/guide/rest-api.md` or `packages/harness/docs/guide/management-api.md` (published via the `apps/docs` site — `pnpm docs:build` to verify). Guard: `apps/api/tests/integration/openapi.test.ts` ("documents every public path").
