---
name: add-pattern-or-model
description: Procedures for adding an agent-loop pattern (registerPattern) or a model provider (registerModelProvider) to the Felix open registries.
when_to_use: 'Requests like "add a pattern", "new agent loop", "add a model provider", "support another LLM"; questions about registerPattern, PatternBuildContext, ModelClient, MODEL_ROUTES, registerModelProvider.'
---

# Adding a pattern or model provider

Both registries are open: one `register*(...)` call in the module's bottom matter, no builder changes.

## New pattern

1. Write a builder `(ctx: PatternBuildContext) => Agent | Promise<Agent>` in `packages/harness/src/patterns/<name>.ts`. `PatternBuildContext` (`packages/harness/src/patterns/registry.ts`) provides `env, manifest, modelSpec, tools` (already governance-wrapped), `subAgents`, `systemPrompt`, `sessionStore/Strategy`, `limits`, `recursionLimit`, etc. Exemplar: `packages/harness/src/patterns/reflect.ts` (wraps a react base; registration at the bottom of the file).
2. Self-register at module load:
   ```ts
   registerPattern('name', builder, { kind: 'single-agent' | 'multi-agent' });
   ```
3. **Add a side-effect import** to the block at `packages/harness/src/manifests/builder.ts` (~lines 49–55: `import '../patterns/reflect';` etc.) — without it the module never loads and the pattern never registers.
4. Cross-field manifest rules auto-apply from `kind` via `isMultiAgentPattern` in `packages/harness/src/manifests/validate.ts`: multi-agent requires `sub_agents` and forbids peers/containers/queues/sandboxes/browser_tools; single-agent forbids `sub_agents`; durable mode requires single-agent + checkpointed memory.
5. If the pattern makes model calls per child/iteration, call `checkTokenBudget(limits, manifestId)` before each (see router/parallel), and emit pattern-specific audit events (`judge_score` with `payload.source`, `plan_step`, ...) like reflect/plan_execute do.
6. Tests: registry mechanics `packages/harness/tests/unit/patterns/registry.test.ts` (use `_resetPatternRegistry`); behavior tests like `packages/harness/tests/unit/reflect_pattern.test.ts`.

## New model provider

1. Implement `ModelClient` (`packages/harness/src/patterns/model.ts`): `chat()`, `streamChat()` — an `AsyncGenerator<string, ModelChatResult>` where text deltas yield and the final assistant turn (tool_calls, thinking blocks, usage) is the generator's **return** value — plus optional `countTokens()`. Honor `ModelChatOptions.signal` in fetches and report usage via `recordUsage()` so token limits and `orchestrator_tokens` counters work.
2. Register: `registerModelProvider('name', (env, modelId, route, spec) => new Client(...))` (`packages/harness/src/patterns/model-registry.ts`). Canonical exemplars: bottom of `packages/harness/src/patterns/model.ts` (~line 1406, anthropic/openai/workers-ai). Deploy-time registration from `composition.ts` also works.
3. Route logical model ids via the `MODEL_ROUTES` env JSON (`parseModelRoutes` in `packages/harness/src/env.ts`): `{ "<logical-id>": { "provider": "name", "model": "..." } }`.
4. `spec.model.fallbacks` and `confidence_escalation` wrap any provider automatically — no per-provider work.
5. Tests: `packages/harness/tests/unit/patterns/model_registry.test.ts` (use `_resetModelProviderRegistry`), plus streaming/caching behavior tests modeled on `anthropic_streaming.test.ts` / `workers_ai_streaming.test.ts`.
