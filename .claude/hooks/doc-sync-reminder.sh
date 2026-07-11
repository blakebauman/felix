#!/bin/bash
# PostToolUse hook (Edit|Write|MultiEdit): when a source surface with a
# documentation counterpart changes, remind Claude which docs/OpenAPI
# artifacts must be kept in sync. Reminder-only; the Stop-hook drift gate
# (doc-drift-stop.sh) is the enforcement backstop.
fp=$(jq -r '.tool_input.file_path // empty')
[ -z "$fp" ] && exit 0
rel="${fp#"$CLAUDE_PROJECT_DIR"/}"
case "$rel" in .claude/*) exit 0;; esac

emit() {
  jq -cn --arg ctx "$1" \
    '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
  exit 0
}

case "$rel" in
  packages/harness/src/api/*.ts|packages/harness/src/app.ts)
    emit "Route surface changed: new/changed routes must be registered via createRoute + .openapi() (shared helpers in packages/harness/src/api/openapi-shared.ts) or they will be INVISIBLE in /openapi.json. Update packages/harness/docs/guide/rest-api.md (public surface) or docs/guide/management-api.md (scoped surface). Guard: pnpm test -- apps/api/tests/integration/openapi.test.ts ('documents every public path'). See the docs-sync skill."
    ;;
  packages/harness/src/manifests/schema.ts)
    emit "Manifest schema changed: keep .openapi() field metadata + the golden example in ManifestSchema.openapi({example}) current, update packages/harness/docs/guide/manifest-reference.md. Guards: packages/harness/tests/unit/manifest_schema.test.ts, apps/api/tests/integration/openapi.test.ts."
    ;;
  packages/harness/src/audit/models.ts|packages/harness/src/observability/metrics.ts)
    emit "Audit/metrics surface changed: update packages/harness/docs/internals/observability.md (event-type catalog / counter names) and the observability skill's catalogs if a type or counter was added."
    ;;
  packages/harness/src/env.ts)
    emit "Env bindings changed: mirror in apps/api/wrangler.example.jsonc + apps/api/.dev.vars.example (if a secret), root vitest.config.ts miniflare.bindings (if integration tests use it), and document in packages/harness/docs/guide/deploy.md / getting-started.md."
    ;;
  packages/commerce/src/*router*.ts|packages/commerce/src/*/router*.ts|packages/commerce/src/*models*.ts|packages/commerce/src/*/models*.ts)
    emit "Commerce surface changed: routes need createRoute + .openapi() registration to appear in /openapi.json; update packages/commerce/docs/index.md (Commerce section of the docs site)."
    ;;
esac
exit 0
