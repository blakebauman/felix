#!/bin/bash
# SessionStart hook: warn when the working copy is missing gitignored files
# that dev/typecheck/test depend on. Stdout is injected into context.
root="${CLAUDE_PROJECT_DIR:-.}"
if [ ! -f "$root/packages/harness/src/manifests/bundled.ts" ]; then
  echo "Felix: generated bundles missing (packages/harness/src/manifests/bundled.ts is gitignored but imported). Run 'pnpm build' before typecheck/test/dev or they will fail with unresolved imports."
fi
if [ ! -f "$root/apps/api/wrangler.jsonc" ]; then
  echo "Felix: apps/api/wrangler.jsonc missing (gitignored). Run: cp apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc"
fi
exit 0
