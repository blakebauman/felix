#!/bin/bash
# PostToolUseFailure hook (matcher: Bash): when a build/test/typecheck command
# fails, inject the Felix failure-classification playbook so the fix starts
# from known causes instead of raw exploration.
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
case "$cmd" in
  *"pnpm test"*|*"pnpm typecheck"*|*"pnpm build"*|*vitest*|*"tsc "*|*"pnpm lint"*)
    jq -cn --arg ctx "Felix failure playbook: 1) 'cannot find module .../bundled' → run 'pnpm build' (generated bundles are gitignored). 2) Unknown/undefined binding in the workers vitest project → add it to miniflare.bindings in the root vitest.config.ts AND packages/harness/src/env.ts. 3) plugin_boundary.test.ts → illegal import direction (harness must never import @felix/commerce; only apps/api/src/composition.ts may). 4) cross_tenant.test.ts → missing tenant_id scoping or non-tenant-first PK. 5) local D1 'no such table' → 'pnpm migrate:local'. 6) manifest_schema.test.ts after schema edits → sub-schema not .strict(), missing .default(), or stale golden example. For anything else, consider delegating to the felix-test-debugger subagent." \
      '{hookSpecificOutput:{hookEventName:"PostToolUseFailure",additionalContext:$ctx}}'
    ;;
esac
exit 0
