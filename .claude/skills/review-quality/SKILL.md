---
name: review-quality
description: Review Felix code changes for code quality and project conventions — request-scoped state, ToolError taxonomy, Zod strictness, plugin boundary, resolver discipline, reuse of existing seams.
when_to_use: 'Requests like "review my changes", "code quality review", "check this against conventions", "is this idiomatic for this repo", or before committing a nontrivial diff.'
---

# Review: code quality / conventions

## Target

Default: the current diff — `git diff` + `git diff --cached` (fall back to `git diff main...HEAD` for branch review). If the user names files or a PR, review those instead.

For diffs touching more than a handful of files, delegate to the **felix-reviewer** subagent and pass this checklist as the lens; run inline for small diffs.

## Mechanical baseline first

`pnpm lint && pnpm typecheck` (after `pnpm build` if bundles may be stale). Don't hand-report what Biome/tsc already catches.

## Checklist

- **Request-scoped state**: no module-level mutable state affecting request handling; cross-cutting concerns read `RequestContext` via `getContext()` / `requireContext()` (`packages/harness/src/context.ts`) — never parameter-threaded limit/policy state into tool signatures.
- **ToolError taxonomy** (`packages/harness/src/tools/errors.ts`): only the closed set of codes; soft errors via `toolErrorOutput`, hard via `throw ToolError`; no raw `throw new Error` inside executors.
- **Zod strictness**: manifest sub-schemas and tool arg schemas are `.strict()` with `.default()` + `.openapi()` where applicable (`packages/harness/src/manifests/schema.ts`).
- **Plugin boundary**: the harness (`packages/harness/src`) never imports `@felix/commerce`; only `apps/api/src/composition.ts` does (root import, no subpath); `packages/commerce` never relative-imports outside its own dir — harness seams via `@felix/harness/<path>`. (`apps/api/tests/unit/plugin_boundary.test.ts` is the oracle — anything it would flag is a finding.)
- **Resolver discipline**: request-path code uses `resolveManifest(env, tenantId, name)`; sync `loadManifest` only in system-only call sites (cron, discovery card, MCP default, federation).
- **Reuse over reinvention**: denials via `denyOutput`, wrapping via `wrapExecutor`, audit via `recordEvent`/`recordEventDetached`, metrics via `recordCounter`/`recordHistogram` — flag hand-rolled equivalents.
- **Style**: Biome idiom (single quotes, semicolons, trailing commas, 100 col, 2-space); comment density matching surrounding code; no PR-narration comments.
- **Docs drift**: if the change alters an architecture fact stated in CLAUDE.md, packages/harness/docs/internals/*, or packages/commerce/docs/*, those need updating too (published via the `apps/docs` site).

## Output

Severity-ranked findings (`critical / warning / nit`) with `file:line` and a one-line fix per finding. State "no findings" per category you cleared.
