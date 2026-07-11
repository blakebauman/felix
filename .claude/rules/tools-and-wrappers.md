---
paths:
  - "packages/harness/src/tools/**"
  - "packages/harness/src/policy/**"
  - "packages/harness/src/guardrails/**"
  - "packages/harness/src/limits/**"
  - "packages/harness/src/approvals/**"
  - "apps/api/src/composition.ts"
---

# Tool & governance-wrapper rules

- Tools: `defineTool` (local, strict Zod args) or `defineToolWithExecutor` (non-local transports). Register in `apps/api/src/composition.ts:compose()`; commerce tools go through the plugin's `registerTools` instead.
- Errors: only the closed `ToolErrorCode` taxonomy from `packages/harness/src/tools/errors.ts` (`invalid_arguments | transport_unavailable | provider_error | timeout | user_aborted | rate_limited | permission_denied | internal`). Soft → `toolErrorOutput(code, msg)`; hard → `throw new ToolError(code, msg)`. Never invent codes; never raw `throw new Error` in executors.
- Request state via `getContext()` / `requireContext()` — never parameter-thread limit/policy state. Thread `ctx.signal` into every fetch/long-running call.
- Wrappers: replace executors only via `wrapExecutor(inner.executor, ...)` (preserves the `transport` label). Deny via `denyOutput(content, source)`; every outer/post-call wrapper checks `isWrapperDeny(output)` FIRST and passes denials through untouched. Chain order in `packages/harness/src/manifests/builder.ts` is behavior — don't reorder casually.
- Deny paths emit an audit event (`recordEvent`) + counter (`recordCounter`); `tool_call` audit rows are skipped on wrapper deny (contract pinned by `packages/harness/tests/unit/audit_emission.test.ts`).
