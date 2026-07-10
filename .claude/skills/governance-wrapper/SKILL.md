---
name: governance-wrapper
description: Procedure for adding or modifying a governance executor wrapper (policy, limits, guardrail, judge, approval) in the Felix build pipeline.
when_to_use: 'Requests like "add a guardrail", "add a policy wrapper", "new judge"; approvals gating, wrapExecutor, denyOutput, isWrapperDeny, the governance pipeline, applyPolicies, applyLimits.'
---

# Governance wrappers

## The chain (fixed order — packages/core/src/manifests/builder.ts ~262–288)

`mergeWithManifest(policies, approvals)` → `applyPolicies` → `applyLimits` → `applyGuardrails` → `applyJudges` → `applyApprovals`

Each stage maps `Tool[] → Tool[]`, replacing `tool.executor`. Insert a new stage deliberately and document why it sits at that position — ordering is behavior (later wrappers run "outside" earlier ones on the call path).

## Contract

1. **Wrap, don't replace**: `wrapExecutor(inner.executor, async (args, ctx) => {...})` from `packages/core/src/tools/executor.ts` — this preserves the inner `transport` label, which audit events depend on.
2. **Deny path**: return `denyOutput(content, source)` from `packages/core/src/tools/types.ts` (`source: 'policy' | 'limits' | 'guardrails' | 'approvals'`). The string reaches the LLM; only the flag is branched on.
3. **Outer / post-call wrappers MUST check `isWrapperDeny(output)` first** and pass denials through untouched — e.g. the guardrails output filter must not redact a policy/approval deny string.
4. **Audit + metrics on deny**: emit the matching audit event (`policy_decision`, `limit_exceeded`, `guardrail_block`, ...) via `recordEvent` and a counter via `recordCounter`. Note the contract pinned by `packages/core/tests/unit/audit_emission.test.ts`: `tool_call` audit rows are SKIPPED on wrapper deny.
5. Gate the stage in builder.ts behind an `enabled` check (see `anyLimit(spec.limits)` / `guardrailsEnabled`).

## Exemplar

`packages/core/src/policy/wrap.ts` — minimal template: per-tool applicability map, scope check, deny path with audit + counter.

## Tests

- `packages/core/tests/unit/governance_wrappers.test.ts` — deny/pass contracts across the chain.
- Wrapper-specific: `guardrails.test.ts`, `judge_wrap.test.ts`, `limits_abort.test.ts`.
- `packages/core/tests/unit/audit_emission.test.ts` — deny-skip contract.

Run: `pnpm test -- packages/core/tests/unit/governance_wrappers.test.ts packages/core/tests/unit/audit_emission.test.ts`
