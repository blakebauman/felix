#!/bin/bash
# PreToolUse hook (Edit|Write|MultiEdit): deny edits to generated, gitignored bundle files.
# Bundles are rebuilt by `pnpm build:manifests`; docs-site content is synced by
# `pnpm --filter @felix/docs sync`. Edit the sources instead.
fp=$(jq -r '.tool_input.file_path // empty')
case "$fp" in
  */src/manifests/bundled.ts|*/src/skills/bundled.ts|src/manifests/bundled.ts|src/skills/bundled.ts|*/apps/docs/src/content/docs/*|apps/docs/src/content/docs/*)
    cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"This file is GENERATED (gitignored). Bundles are rebuilt by pnpm build:manifests; docs-site content is synced from packages/{harness,commerce}/docs/**/*.md by the @felix/docs sync script. Edit the sources instead."}}
EOF
    exit 0;;
esac
exit 0
