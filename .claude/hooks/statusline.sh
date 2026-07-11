#!/bin/bash
# Statusline: model, branch + dirty count, bundle/wrangler presence at a glance.
input=$(cat)
model=$(printf '%s' "$input" | jq -r '.model.display_name // .model.id // "?"')
proj=$(printf '%s' "$input" | jq -r '.workspace.project_dir // .cwd // "."')
cd "$proj" 2>/dev/null

branch=$(git branch --show-current 2>/dev/null)
[ -z "$branch" ] && branch=$(git rev-parse --short HEAD 2>/dev/null)
dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

b="bundles✗"
[ -f packages/harness/src/manifests/bundled.ts ] && b="bundles✓"
w="wrangler✗"
[ -f apps/api/wrangler.jsonc ] && w="wrangler✓"

echo "felix ⎇ ${branch:-?} (${dirty}±) | $b $w | $model"
