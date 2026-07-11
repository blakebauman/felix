# Testing

Vitest with two projects covering separate concerns.

## Topology

`vitest.config.ts` defines two projects:

| Project | Pool | Includes | Bindings |
|---|---|---|---|
| `unit` | node | `packages/*/tests/**/*.test.ts` + `apps/*/tests/**/*.test.ts` (excluding integration) | none — pure logic, schema, governance wrappers, fake DOs, the plugin-boundary guard |
| `workers` | `@cloudflare/vitest-pool-workers` (miniflare/workerd) | `apps/api/tests/integration/**/*.test.ts` | declared explicitly in the config (not read from `wrangler.jsonc`) |

The workers project does **not** point at `wrangler.jsonc` because the bundled workerd doesn't support the wrapped `AI` binding the production config declares. Bindings are explicitly enumerated in `vitest.config.ts` under `miniflare.{bindings, d1Databases, kvNamespaces, r2Buckets, queueProducers, queueConsumers, durableObjects}` and the AI binding is stubbed via a service worker in test code.

## Running

```bash
pnpm test                                          # both projects
pnpm test:watch                                    # watch mode
pnpm test -- packages/harness/tests/unit/manifest_schema.test.ts    # single file
pnpm test -- --project unit -t "rejects unknown kind"   # single test by name
pnpm test -- --project workers                     # workers only
```

## Adding integration bindings

When a new test needs a Cloudflare binding (e.g. a new DO class, a new Queue, a new Vectorize index), it must be added in **two places**:

1. `apps/api/wrangler.jsonc` for production.
2. `vitest.config.ts` under the appropriate `miniflare` sub-block (`bindings`, `d1Databases`, `kvNamespaces`, `r2Buckets`, `queueProducers`, `queueConsumers`, `durableObjects`) for the workers test project.

The integration tests boot the worker via `SELF.fetch`; the miniflare entry needs `main: './apps/api/src/index.ts'` (the deployable shell, which wires the harness + plugins exactly like production) to know where to compile from.

Beyond the core bindings, the miniflare block also declares the `JOBS_QUEUE` producer (`felix-jobs`, the `transport: queue` tool seam) and plain-var test credentials for the commerce/auth surfaces (`ACP_API_KEY`, `ACP_MERCHANT_TENANT`, `JWKS_PUBLIC`) so those integration tests run without real secrets.

## Stubbing manifests

The bundle script (`pnpm build:manifests`) reads YAML manifests from this repo's own `manifests/*.yaml`. If that directory is empty, the bundle is empty.

Unit and integration tests don't rely on the on-disk bundle. They stub manifests directly:

```ts
import { _clearManifestCaches, parseManifest } from '../../src/manifests/loader';

beforeEach(() => _clearManifestCaches());

it('builds a minimal agent', () => {
  const m = parseManifest({ apiVersion: 'orchestrator/v1', kind: 'Agent',
    metadata: { name: 'unit' },
    spec: { pattern: 'react', auth: { inbound: { allow_anonymous: true } } } });
  // ...
});
```

This keeps tests deterministic and decoupled from the build step.

## Linting and type checking

```bash
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check packages apps
pnpm lint:fix         # biome check --write packages apps
pnpm format           # biome format --write packages apps
```

Biome config: single quotes, semicolons, trailing commas, 100-column width, 2-space indent. `noExplicitAny: warn`, `noUnusedImports: error`.

## What each project is good for

### Unit project — `packages/harness/tests/unit/**` (+ `apps/api/tests/unit/**` for wiring guards)

- Manifest schema and validation logic
- Governance wrappers (policy/limits/guardrails/approvals): construct a fake `Tool`, run the wrapper, assert audit + return value
- Tool registration with `InMemoryToolProvider`; tool transport seam via `tests/unit/tools/executor.test.ts` and `tests/unit/tools/container_executor.test.ts`
- Pattern and model-provider registries (`tests/unit/patterns/registry.test.ts`, `tests/unit/patterns/model_registry.test.ts`)
- Session rendering: `tests/unit/session/strategies.test.ts` covers `full_replay` / `windowed:N`; `tests/unit/session/summarizing.test.ts` covers `summarizing:N` including cache reuse and degraded-windowed fallback; `tests/unit/session_semantic.test.ts` covers `semantic:N` BGE retrieval and pinned-anchor inclusion
- Pure model code: `parseModelRoutes`, `zodToJsonSchema`, the cron matcher
- Anything that doesn't need a real DO or D1

### Workers project — `apps/api/tests/integration/**`

- HTTP routes via `SELF.fetch`
- D1 reads/writes (the miniflare D1 honors `migrations` and runs them on first use if configured)
- Durable Object behavior (real DO state, real `blockConcurrencyWhile`)
- Queue producer + consumer round-trips
- End-to-end agent builds and tool dispatch

## Patterns to follow when writing a new test

1. **Boot the app with a stub provider.** Don't rely on `compose(env)` in tests — pass an explicit `InMemoryToolProvider` with the exact tools the test exercises. Easier to assert against, no cross-test contamination.
2. **Reset module-level caches.** `_clearManifestCaches()` between tests; the per-router agent cache lives on a router instance, so use a fresh `buildChatRouter({ tools })` for each test.
3. **Time control.** Tests that exercise wall-clock limits or cron should pass an explicit `at` parameter where the production code supports it (e.g. `runScheduledJobs(env, at)`) — avoid mocking `Date.now()` across the whole suite.
4. **Audit events.** Read them back via `listEvents(env, { tenantId, limit })` and assert event_type + status + payload keys. Don't snapshot the full payload — the audit shape evolves and the tenant id / timestamps churn.
5. **Tenant isolation.** Always write at least one assertion proving a different tenant cannot see the rows you just wrote. Composite-key invariants are easy to break in a follow-up; the test is the safety net. `apps/api/tests/integration/cross_tenant.test.ts` is the dedicated cross-tenant probe and the right reference when adding similar coverage.

## Common test fixtures (informal)

There is no shared fixtures module today. Common ad-hoc patterns in the existing suite:

- `makeFakeTool(name, returns)` — `defineTool({ name, args: z.object({}), async handler() { return returns; } })`. For non-local transports, build with `defineToolWithExecutor({ ..., executor: { transport: 'fake', async execute() { return returns; } } })`.
- `withCtx(authCtx, fn)` — wraps `fn` in `runWithContext({ env, auth: authCtx, limitState: newLimitState() }, fn)` so wrappers reading `getContext()` find what the test expects.
- Building principals: `{ subject: 'u1', tenantId: 't1', scopes: ['a'], issuer: 'https://test' }` and passing them through a constructed `AuthContext`.
- `recordingSessionStore()` / `mutableSession()` — in-memory `SessionStore` / `Session` implementations for pattern tests (see `tests/unit/react_hydration.test.ts`, `tests/unit/groupchat_persistence.test.ts`, `tests/unit/session/summarizing.test.ts`).
- Pattern registry tests use module-level side-effect imports (`import '../../../src/patterns/react'`) so the built-ins self-register before assertions run. The registry is a process singleton; tests register additional patterns with names that can't collide with built-ins (e.g. `'echo-test-pattern'`).

Promote a fixtures module once the same boilerplate appears in more than three test files.
