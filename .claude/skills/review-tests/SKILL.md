---
name: review-tests
description: Review Felix changes for test coverage and test quality — seam-to-guard-test mapping, unit vs integration placement, miniflare bindings, behavior-not-implementation assertions.
when_to_use: 'Requests like "review the tests", "is this covered", "what tests should this have", "test coverage review", or after implementing a feature whose tests feel thin.'
---

# Review: tests

## Target

Default: current diff (`git diff` + `git diff --cached`, or `git diff main...HEAD`). Delegate large diffs to the **felix-reviewer** subagent with this checklist as the lens.

## Seam → guard-test map

Every changed seam should show a delta in (or new tests alongside) its guard:

| Changed seam | Guard tests |
|---|---|
| Tool / provider | `packages/harness/tests/unit/tool_provider.test.ts`, `packages/harness/tests/unit/tools/executor.test.ts` (+ per-transport `tools/*_executor.test.ts`) |
| Pattern | `packages/harness/tests/unit/patterns/registry.test.ts` + a behavior test (`reflect_pattern`, `plan_execute_pattern`, `react_*`) |
| Model provider/client | `packages/harness/tests/unit/patterns/model_registry.test.ts`, `*_streaming/_caching.test.ts`, `model_fallbacks` |
| Manifest schema | `packages/harness/tests/unit/manifest_schema.test.ts` (+ `manifests_resolver`, `builder`) |
| Governance wrapper | `packages/harness/tests/unit/governance_wrappers.test.ts` + `audit_emission.test.ts` (deny-skip contract) |
| Migration / new table | `apps/api/tests/integration/cross_tenant.test.ts` + an integration test exercising the table |
| Session | `packages/harness/tests/unit/session/*`, `checkpointer*`, `session_{anchor,semantic}` |
| Auth / security | `auth_{jwt,middleware}`, `security_*` |
| Routes / plugin surface | `apps/api/tests/integration/*` for that mount |

A changed source file with **no corresponding test delta** is a finding unless the change is genuinely untestable plumbing.

## Placement rules

- Pure logic / schema / wrappers with fakes → `packages/harness/tests/unit/**` (node pool); app-wiring guards (plugin boundary etc.) → `apps/api/tests/unit/**`.
- Anything needing real bindings (D1, KV, R2, queues, DOs) → `apps/api/tests/integration/**` (miniflare) — and any NEW binding must be added to the `miniflare.bindings` block in `vitest.config.ts`, or the whole workers project fails.

## Quality checks

- Assert **behavior, not implementation**: deny paths via the `denyOutput`/`isWrapperDeny` output contract; audit via event type + payload, not internal call counts.
- Registry tests use the `_reset*Registry` / `_clearManifestCaches` helpers — no module-reload hacks.
- Tenant-scoped assertions: new-table tests must prove tenant A's rows are invisible to tenant B.
- Before judging a "missing module bundled.ts" failure, confirm `pnpm build` ran — that failure is environmental, not a coverage gap.

## Output

Per changed seam: covered / partially covered / uncovered, with the specific missing case and a suggested test (file + describe/it sketch). Then run the narrowest relevant `pnpm test -- <files>` to confirm the existing suite is green.
