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
  src/api/*.ts|src/app.ts)
    emit "Route surface changed: new/changed routes must be registered via createRoute + .openapi() (shared helpers in src/api/openapi-shared.ts) or they will be INVISIBLE in /openapi.json. Update docs/guide/rest-api.md (public surface) or docs/guide/management-api.md (scoped surface) + run 'pnpm build:docs'. Guard: pnpm test -- tests/integration/openapi.test.ts ('documents every public path'). See the docs-sync skill."
    ;;
  src/manifests/schema.ts)
    emit "Manifest schema changed: keep .openapi() field metadata + the golden example in ManifestSchema.openapi({example}) current, update docs/guide/manifest-reference.md, then 'pnpm build:docs'. Guards: tests/unit/manifest_schema.test.ts, tests/integration/openapi.test.ts."
    ;;
  src/audit/models.ts|src/observability/metrics.ts)
    emit "Audit/metrics surface changed: update docs/internals/observability.md (event-type catalog / counter names) and the observability skill's catalogs if a type or counter was added, then 'pnpm build:docs'."
    ;;
  src/env.ts)
    emit "Env bindings changed: mirror in wrangler.example.jsonc + .dev.vars.example (if a secret), vitest.config.ts miniflare.bindings (if integration tests use it), and document in docs/guide/deploy.md / getting-started.md, then 'pnpm build:docs'."
    ;;
  packages/commerce/src/*router*.ts|packages/commerce/src/*/router*.ts|packages/commerce/src/*models*.ts|packages/commerce/src/*/models*.ts)
    emit "Commerce surface changed: routes need createRoute + .openapi() registration to appear in /openapi.json; update docs/internals/commerce.md, then 'pnpm build:docs'."
    ;;
esac
exit 0
