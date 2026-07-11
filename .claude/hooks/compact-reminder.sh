#!/bin/bash
# SessionStart (matcher: compact): re-pin load-bearing Felix constraints after
# compaction so they survive context summarization.
cat <<'EOF'
Felix post-compaction reminders:
- Doc-drift Stop gate is active: changes to packages/harness/src/api|app.ts|manifests/schema.ts|audit/models.ts|env.ts, apps/api/src, apps/api/migrations, or commerce routers/models require matching packages/{harness,commerce}/docs/*.md or CLAUDE.md updates (docs-sync skill) before ending the turn.
- Generated files (packages/harness/src/{manifests,skills}/bundled.ts, apps/docs/src/content/docs/**) are never edited directly — rebuild with pnpm build:manifests / the @felix/docs sync.
- Staging/production commands (deploy, remote migrations, secrets) are ask-gated — never work around a denied gate.
- Path-scoped conventions live in .claude/rules/; procedures in .claude/skills/.
EOF
exit 0
