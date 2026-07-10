---
paths:
  - "packages/core/src/tools/**"
  - "packages/core/src/policy/**"
  - "packages/core/src/guardrails/**"
  - "packages/core/src/limits/**"
  - "packages/core/src/approvals/**"
  - "packages/core/src/composition.ts"
---

# Tool & governance-wrapper rules

- Tools: `defineTool` (local, strict Zod args) or `defineToolWithExecutor` (non-local transports). Register in `packages/core/src/composition.ts:compose()`; commerce tools go through the plugin's `registerTools` instead.
- Errors: only the closed `ToolErrorCode` taxonomy from `packages/core/src/tools/errors.ts` (`invalid_arguments | transport_unavailable | provider_error | timeout | user_aborted | rate_limited | permission_denied | internal`). Soft → `toolErrorOutput(code, msg)`; hard → `throw new ToolError(code, msg)`. Never invent codes; never raw `throw new Error` in executors.
- Request state via `getContext()` / `requireContext()` — never parameter-thread limit/policy state. Thread `ctx.signal` into every fetch/long-running call.
- Wrappers: replace executors only via `wrapExecutor(inner.executor, ...)` (preserves the `transport` label). Deny via `denyOutput(content, source)`; every outer/post-call wrapper checks `isWrapperDeny(output)` FIRST and passes denials through untouched. Chain order in `packages/core/src/manifests/builder.ts` is behavior — don't reorder casually.
- Deny paths emit an audit event (`recordEvent`) + counter (`recordCounter`); `tool_call` audit rows are skipped on wrapper deny (contract pinned by `packages/core/tests/unit/audit_emission.test.ts`).
