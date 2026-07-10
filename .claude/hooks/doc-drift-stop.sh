#!/bin/bash
# Stop hook: docs-drift oversight gate (AI-driven development, human oversight).
# If the session's working-tree changes touch API/schema surfaces but no
# documentation was updated, block the stop ONCE per drift-set per session and
# ask Claude to either sync the docs (docs-sync skill) or state why no doc
# change is needed. Fires at most once per unique drift-set per session.
input=$(cat)

# Never loop: if we already blocked and Claude continued, let it stop.
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
changed=$({ git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sort -u)
[ -z "$changed" ] && exit 0

# Surfaces whose changes usually require a docs/OpenAPI update.
api=$(printf '%s\n' "$changed" | grep -E '^(src/api/|src/app\.ts$|src/manifests/schema\.ts$|src/audit/models\.ts$|src/env\.ts$|migrations/|packages/commerce/src/.*(router|models))' )
[ -z "$api" ] && exit 0

# Any doc-side change in the same working tree counts as "docs were considered".
printf '%s\n' "$changed" | grep -qE '^(docs/.*\.md$|CLAUDE\.md$|docs/guide/|docs/internals/)' && exit 0

# Once per session per drift-set.
sid=$(printf '%s' "$input" | jq -r '.session_id // "nosession"')
hash=$(printf '%s\n' "$api" | shasum | cut -c1-12)
state="${TMPDIR:-/tmp}/felix-docdrift-$sid"
grep -qs "$hash" "$state" 2>/dev/null && exit 0
echo "$hash" >> "$state"

files=$(printf '%s\n' "$api" | head -8 | tr '\n' ' ')
jq -cn --arg r "Doc-drift check: this working tree changes API/schema surfaces ($files) but no docs/*.md or CLAUDE.md changed. Use the docs-sync skill to update the mapped doc page(s) and OpenAPI route metadata (then 'pnpm build:docs'), or tell the user explicitly why no documentation change is needed. This check fires once per drift-set per session." \
  '{decision:"block", reason:$r}'
exit 0
