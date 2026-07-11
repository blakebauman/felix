---
name: manifest-schema-change
description: Checklist for adding or changing a field in the orchestrator/v1 manifest schema (Zod + OpenAPI + builder + docs) for the Felix orchestrator.
when_to_use: 'Requests like "add a manifest field", "extend the manifest", "new spec option"; manifest schema changes, ManifestSchema, AgentSpec, manifest-reference edits.'
---

# Changing the manifest schema

All manifest Zod schemas are **`.strict()`** — unknown keys are rejected, so every new field is a schema change.

## Checklist

1. **Schema** (`packages/harness/src/manifests/schema.ts`): add the field to the relevant sub-schema. Keep the object `.strict()`. Give it a `.default(...)` (nested objects use `.default(SubSchema.parse({}))`) and `.openapi({ description, example })` metadata — this feeds the `/docs` reference.
2. **Cross-field rules** (`packages/harness/src/manifests/validate.ts:validateManifest`): add a rule if the field interacts with pattern kind, execution mode, or other fields (exemplar: durable mode requires single-agent + checkpointed memory).
3. **Consume** it in `packages/harness/src/manifests/builder.ts:buildAgent` — as a pipeline step (e.g. tool auto-injection) or by threading it into `PatternBuildContext`.
4. **Golden example**: update the full example object in `ManifestSchema.openapi({ example })` near the bottom of schema.ts — it enumerates every spec key.
5. **Docs**: document in `packages/harness/docs/guide/manifest-reference.md` (published via the `apps/docs` site; `pnpm docs:build` to verify).
6. **Bundled manifests**: if any `packages/harness/manifests/*.yaml` should use the field, edit them and run `pnpm build:manifests`.
7. **Type export**: add to the exported types at the bottom of schema.ts if consumed elsewhere.

## Tests

- `packages/harness/tests/unit/manifest_schema.test.ts` — strictness, defaults, `.parse({})` round-trips. Add cases for the new field (accepts valid, rejects unknown sibling keys, default materializes).
- If validate.ts changed: extend its cases there too.
- `pnpm build && pnpm test -- packages/harness/tests/unit/manifest_schema.test.ts && pnpm typecheck`
