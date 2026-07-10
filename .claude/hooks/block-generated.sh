#!/bin/bash
# PreToolUse hook (Edit|Write|MultiEdit): deny edits to generated, gitignored bundle files.
# These are rebuilt by `pnpm build:manifests` / `pnpm build:docs` — edit the sources instead.
fp=$(jq -r '.tool_input.file_path // empty')
case "$fp" in
  */src/manifests/bundled.ts|*/src/skills/bundled.ts|*/src/docs/bundled.ts|src/manifests/bundled.ts|src/skills/bundled.ts|src/docs/bundled.ts)
    cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"This file is GENERATED (gitignored, rebuilt by pnpm build:manifests / pnpm build:docs). Edit the sources instead — manifests/*.yaml, skills/*/SKILL.md, or docs/**/*.md — then run the build script."}}
EOF
    exit 0;;
esac
exit 0
