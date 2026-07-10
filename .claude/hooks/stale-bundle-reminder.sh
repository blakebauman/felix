#!/bin/bash
# PostToolUse hook (Edit|Write|MultiEdit): remind Claude about follow-up steps
# after editing bundle sources, docs, migrations, or wrangler.example.jsonc.
# Reminder-only by design — never auto-runs builds.
fp=$(jq -r '.tool_input.file_path // empty')
[ -z "$fp" ] && exit 0

# Repo-relative path (strip the project dir prefix if present).
rel="${fp#"$CLAUDE_PROJECT_DIR"/}"

# Never fire for Claude Code config under .claude/ (e.g. .claude/skills/*/SKILL.md).
case "$rel" in .claude/*) exit 0;; esac

emit() {
  jq -cn --arg ctx "$1" \
    '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
  exit 0
}

case "$rel" in
  manifests/*.yaml|manifests/*.yml|skills/*/SKILL.md)
    emit "Bundle source changed: run 'pnpm build:manifests' before dev/test/typecheck — src/manifests/bundled.ts + src/skills/bundled.ts are now stale (the Worker reads the bundle, not the YAML)."
    ;;
  docs/*.md|docs/*/*.md)
    emit "Docs changed: run 'pnpm build:docs' — src/docs/bundled.ts is now stale (the in-Worker docs site reads the bundle)."
    ;;
  migrations/*.sql)
    emit "Migration checklist: sequential NNNN prefix (check 'ls migrations/' head); tenant-first composite PK (tenant_id, id); tenant-scoped indexes ((tenant_id, ts DESC) for time-series); INTEGER booleans/epoch-ms timestamps; TEXT JSON; plugin-prefixed names for plugin tables. Then run 'pnpm migrate:local'. tests/integration/cross_tenant.test.ts guards isolation."
    ;;
  wrangler.example.jsonc)
    emit "If you added/changed a binding: mirror it in src/env.ts AND in the miniflare.bindings block of vitest.config.ts — integration tests do NOT read wrangler config."
    ;;
esac
exit 0
