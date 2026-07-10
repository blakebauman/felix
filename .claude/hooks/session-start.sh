#!/bin/bash
# SessionStart hook: warn when the working copy is missing gitignored files
# that dev/typecheck/test depend on. Stdout is injected into context.
d="${CLAUDE_PROJECT_DIR:-.}"
if [ ! -f "$d/src/manifests/bundled.ts" ] || [ ! -f "$d/src/docs/bundled.ts" ]; then
  echo "Felix: generated bundles missing (src/manifests/bundled.ts / src/docs/bundled.ts are gitignored but imported). Run 'pnpm build' before typecheck/test/dev or they will fail with unresolved imports."
fi
if [ ! -f "$d/wrangler.jsonc" ]; then
  echo "Felix: wrangler.jsonc missing (gitignored). Run: cp wrangler.example.jsonc wrangler.jsonc"
fi
exit 0
