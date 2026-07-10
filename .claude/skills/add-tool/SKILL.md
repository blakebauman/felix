---
name: add-tool
description: Procedure for registering a new tool in the Felix orchestrator via the ToolProvider in packages/core/src/composition.ts, with the executor-transport seam and ToolError taxonomy.
when_to_use: 'Requests like "add a tool", "register a tool", "new tool", "expose X to the agent"; questions about defineTool, defineToolWithExecutor, tool executors, tool transports, or ToolError.'
---

# Adding a tool to Felix

## Procedure

1. **Author the tool as a factory.** Worker-local tools use `defineTool({ name, description, args, handler })` from `packages/core/src/tools/types.ts` — it wraps the handler in a `localExecutor` and auto-parses args. Args must be a **strict Zod object** (`z.object({...}).strict()`).
2. **Register with one line** in `packages/core/src/composition.ts:compose()`:
   ```ts
   provider.register('my_tool', () => defineTool({ ... }));
   ```
   Canonical exemplar: `calculator` at `packages/core/src/composition.ts:57`. Tools that need request state (tenant, thread, limits) read it via `getContext()` / `requireContext()` from `packages/core/src/context.ts` — see the skill-activation tools in composition.ts. **Never parameter-thread limit/policy state.**
3. **Non-local transports** (mcp / a2a / container / queue / sandbox / browser) use `defineToolWithExecutor({ ..., executor })` and supply their own executor. Usually you don't write these by hand — the builder creates them from manifest `mcp_servers` / `peers` / `containers` / `queues` / `sandboxes` / `browser_tools` entries.
4. **Errors: closed taxonomy only** (`packages/core/src/tools/errors.ts`). Soft failure the model should recover from → return `toolErrorOutput(code, msg)`. Hard failure → `throw new ToolError(code, msg)`. Codes: `invalid_arguments | transport_unavailable | provider_error | timeout | user_aborted | rate_limited | permission_denied | internal`. Do NOT invent codes — operators alert on this taxonomy and the anomaly detector groups by it. `fatal: true` on the Tool terminates the react loop instead of feeding the error back.
5. **Cancellation:** thread `ctx.signal` into any `fetch` / long work (`fetch(url, { signal: ctx.signal })`). Without it, wall-clock breaches only block the *next* call.
6. **Expose in a manifest:** add the tool name to the manifest's `tools:` list (then `pnpm build:manifests` if it's a bundled YAML).
7. **Commerce tools** do not go in composition.ts — they go through the plugin's tool factories in `packages/commerce` (registered via `FelixPlugin.registerTools`).

## Tests

- Provider mechanics: `packages/core/tests/unit/tool_provider.test.ts`
- Executor seam / transport preservation: `packages/core/tests/unit/tools/executor.test.ts`
- Add a unit test for the new tool's handler (strict-args rejection + happy path).

Run: `pnpm build && pnpm test -- packages/core/tests/unit/tool_provider.test.ts packages/core/tests/unit/tools/executor.test.ts`
