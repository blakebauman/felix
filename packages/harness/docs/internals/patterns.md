---
description: "Loop semantics for all seven Felix patterns — react, deep, router, parallel, groupchat, reflect, plan_execute."
---

# Patterns

The seven execution patterns. All are implemented from scratch in `src/patterns/*` — no LangGraph.

## react

`src/patterns/react.ts`. The default pattern. A hand-written sequential tool-calling loop.

### Initialization

When `buildReactAgent` returns, the agent holds:

- `model` — resolved via `buildModel(env, modelSpec)` (`src/patterns/model.ts`), which dispatches through the model-provider registry (`anthropic` / `openai` / `workers-ai` self-register at module load).
- `toolsByName` — `Map<name, Tool>` for O(1) dispatch.
- `recursion` — `clampLimit(manifest.recursion_limit, ABSOLUTE_LIMITS.recursion_limit)`; default `DEFAULT_RECURSION = 10`. Clamped here as a defense in depth even though the schema already enforces the same ceiling.
- `sessionStore` — `DoSessionStore` or `noopSessionStore` depending on `memory.checkpointer`.
- `strategy` — the `SessionStrategy` chosen by `spec.session.strategy` (`full_replay` / `windowed:N` / `summarizing:N` / `semantic:N`).
- `toolsRetrieval` — Optional JIT tool retrieval config from `spec.tools_retrieval`. When `enabled: true`, the loop calls `selectTopKTools(opts.tools, messages, opts.toolsRetrieval)` before each `model.chat` to filter to the top-K most relevant tools by BGE cosine similarity. The full `toolMap` stays available for dispatch (a hallucinated tool name still routes through the unknown-tool audit path).
- `artifacts` — Optional artifact spill config from `spec.artifacts`. When `enabled: true`, tool results above `threshold_chars` are spilled to R2 and the model-facing string is replaced with `[artifact:REF] preview…`. The auto-injected `fetch_artifact` tool reads back.

### invoke()

1. **Open the session and render the working set** — `session = sessionStore.open(threadId ?? '')`, then `messages = await strategy.render(session, input.messages, { systemPrompt, model })`. The strategy decides what the model sees: `full_replay` returns every prior event as a message; `windowed:N` keeps the last N; `summarizing:N` model-summarizes everything older into a synthetic system message and caches the summary as a `kind: 'audit'` event with `metadata: { type: 'session_summary', covers_to_seq: N }` so subsequent renders skip the model call; `semantic:N` embeds the incoming message via BGE and pulls the top-N most relevant prior events instead of the most recent. Anchor messages (`metadata.pinned`) are always included regardless of strategy. Empty `threadId` resolves to a no-op session, so the render is just `[system, ...incoming]`.
2. **Persist new caller turns** — `persistFireAndForget(session, callerEvents, { manifestId })` routes the `appendBatch` through `execCtx.waitUntil` when present so DO writes don't block the loop. Falls back to a bare promise in unit tests without an ExecutionContext. Terminal failures (after the retry described below) emit a `checkpoint_failure` audit event + `orchestrator_checkpoint_failures` counter rather than being swallowed.
3. **Loop** up to `recursion` times:
   - Pre-flight: `checkPreflightTokenBudget(model, messages, tools, limits, manifestId)` projects the next call's input cost via the model client's `countTokens` (Anthropic free `/v1/messages/count_tokens`; no-op for OpenAI/Workers AI), then `checkTokenBudget(limits, manifestId)` checks the cumulative spend on `LimitState.tokens`. Either returning a deny string short-circuits the loop with an assistant message carrying the deny.
   - `result = await model.chat(messages, tools, { signal: currentSignal() })` — the abort signal cancels in-flight gateway fetches on wall-clock breach.
   - `recordUsage(result, { manifestId, modelId })` accumulates token spend onto `LimitState.tokens.{input, output}`.
   - Append `result.message` to messages and newMessages.
   - If `result.stopReason !== 'tool_use'` or no `tool_calls`: persist newMessages, return `{ messages: newMessages, final: result.message }`.
   - Otherwise dispatch each tool_call **sequentially** in order (not `Promise.all`) so audit ordering is deterministic. Each call goes through `tool.executor.execute(args, ctx)` — the transport (`local` / `mcp` / `a2a` / `container` / `queue` / `sandbox` / `browser`) is whatever the tool was built with; governance wrappers preserve the inner transport label. Each tool message is appended to both messages and newMessages.
   - `persistFireAndForget(session, newEvents, { manifestId })` via `waitUntil`. `DoSession.appendBatch` retries 3× (50ms / 150ms / 450ms backoff) on 5xx / network errors before surfacing the failure.
4. **Recursion exhaustion** — return `{ final: { role: 'assistant', content: '[recursion limit reached: N model turns — raise recursion_limit or set max_tool_calls to bound earlier]' } }`.

### streamEvents()

Same control flow with one wrinkle: `model.streamChat(...)` is an `AsyncGenerator<string, ModelChatResult>` — text deltas yield (emitted as `on_chat_model_stream` events), and the final `ModelChatResult` (with `tool_calls` and `usage`) is the generator's **return value**, captured by the loop with `await stream.next()` once `done === true`. This eliminates the earlier double-call (stream for UX, then non-stream for structured tool_calls). Tool dispatch is the same sequential pass, and each dispatch emits `on_tool_start` / `on_tool_end` events around the invoke. On exit, `on_chain_end` carries the final message.

### Audit emission

- `on_tool_start` — recorded as a `tool_call` audit event with the start payload.
- `on_tool_end` — recorded as a `tool_call` audit event with the result payload.
- Governance wrappers (policy/limits/guardrails/judges/approvals) emit their own audit events from inside the call.

## deep

`src/patterns/deep.ts`. Identical loop mechanics to react, with two additions:

- `PLAN_TOOLS = [plan_create, plan_update_step, plan_get]` is auto-injected by the **core builder** (`buildAgent`) into `resolvedTools` when `spec.pattern === 'deep'`, BEFORE the governance pipeline — so the plan tools are gated by policies/limits/guardrails/judges/approvals like any other tool. The adapter itself no longer injects them; it just forwards the already-wrapped `ctx.tools` (along with `tools_retrieval` / `artifacts` opts) into the underlying react agent.
- A planning suffix is appended to the system prompt: "You are a deep agent. Before tool use, draft a short plan via plan_create. Update plan steps as you go using plan_update_step. Finalize with a synthesis when steps are complete."

Plans live in the Postgres `plans` table with a 30-day TTL. See [persistence.md](persistence.md).

## router

`src/patterns/router.ts`. Single-shot classifier dispatch.

### classify()

1. Extract the last user turn from `input.messages`.
2. Pre-flight: `checkPreflightTokenBudget(...) ?? checkTokenBudget(limits, manifestId)` — if the run's token budget is already blown (e.g. shared `LimitState` from an earlier sub-agent fan-in), skip the classifier and deterministically fall back to `subNames[0]` instead of spending more tokens.
3. Call `model.chat` with:
   - `system` = `"${classifierPrompt}\nRespond with one of: ${subNames.join(', ')}."`
   - `temperature = 0`, `max_tokens = 16` (deterministic, fast), `signal: currentSignal()`.
   - `recordUsage(result, ...)` accumulates the call's tokens onto the shared `LimitState`.
4. Parse the response: first token, lowercased, must match a sub-agent name.
5. Fallback to `subNames[0]` if nothing matches.

### invoke()

```ts
const route = await classify(input.messages);
return opts.subAgents[route].invoke(input);   // threadId forwarded
```

The `threadId` is **forwarded** to the chosen child because consecutive user turns should land in the same conversation thread even if the router picks a different child each time. The router caches no per-turn state itself.

## parallel

`src/patterns/parallel.ts`. Fan-out and aggregate.

### Session hydration + fan-out

Like react/groupchat, the parent opens the session and renders the working set before fanning out, then persists the new caller turn:

```ts
const session = sessionStore.open(threadId ?? '');
const rendered = await strategy.render(session, input.messages, { systemPrompt: aggregatorPrompt, model });
persist(session, input.messages);                          // parent is the writer
const childMessages = rendered.filter(m => m.role !== 'system');
const childInput = { messages: childMessages };            // threadId stripped
const results = await Promise.all(
  Object.entries(opts.subAgents).map(async ([name, agent]) => {
    const r = await agent.invoke(childInput);
    return { name, final: r.final };
  }),
);
```

**The `threadId` is stripped before fan-out.** Otherwise N children would concurrently write the same `ConversationDO`, racing on `blockConcurrencyWhile`. Children operate as stateless workers for this run — they see the hydrated transcript but write nothing back. The parent aggregator is the persistent entity: it appends the new caller turn and the synthesized answer to the parent thread, so a `parallel` manifest with `memory.checkpointer: do` is genuinely multi-turn instead of silently forgetting.

### Aggregate

```ts
const summary = results.map(r => `### ${r.name}\n${r.final.content}`).join('\n\n');
// Pre-flight: sub-agents already accumulated tokens into the shared
// LimitState; if the aggregator call would now breach the cap, short-
// circuit to the deny string rather than spending more tokens.
const budgetDeny =
  (await checkPreflightTokenBudget(model, aggregatorMessages, [], limits, manifestId)) ??
  checkTokenBudget(limits, manifestId);
if (budgetDeny) return { role: 'assistant', content: budgetDeny };
const synthesis = await model.chat(aggregatorMessages, [], { signal: currentSignal() });
recordUsage(synthesis, { manifestId, modelId });
return synthesis.message;
```

The aggregator runs without tools — it only synthesizes. Its answer is persisted to the parent thread (guard-then-persist, matching react) before it's returned. If you want a tool-using aggregator, make the parent a router pointing at a react agent with the synthesis as one of its tools.

## groupchat

`src/patterns/groupchat.ts`. Round-robin shared transcript.

```ts
const order = Object.keys(opts.subAgents);
const session = sessionStore.open(threadId ?? '');
const rendered = await strategy.render(session, input.messages, { systemPrompt: moderatorPrompt, model });
const transcript: ChatMessage[] = rendered.filter((m) => m.role !== 'system');
persist(session, input.messages);    // fire-and-forget via execCtx.waitUntil

for (let turn = 0; turn < opts.maxTurns; turn++) {
  const speaker = order[turn % order.length];
  const child = opts.subAgents[speaker];
  const result = await child.invoke({
    messages: [{ role: 'system', content: `${opts.moderatorPrompt}\nYou are speaker '${speaker}'.` }, ...transcript],
    // no threadId — the parent owns the transcript
  });
  const last = { ...result.final, name: speaker };
  transcript.push(last);
  persist(session, [last]);           // parent is the sole DO writer
}

return { messages: transcript, final: transcript[transcript.length - 1] };
```

Each child sees the full chat so far and produces one turn. `max_turns` comes from `manifest.spec.max_turns` (default 4, ceiling 20). Termination is by turn count; there is no consensus-based stop today. The parent is the sole session writer — child invocations are stateless so multiple speakers can't race-write the same DO.

## reflect

`src/patterns/reflect.ts`. Wraps a react base with a verifier model that scores each final response. Below `spec.reflect.threshold`, the critique is appended as a synthetic user turn and react replays up to `spec.reflect.max_iterations`.

### Initialization

```ts
const inner = buildReactAgent(opts);
if (reflect.max_iterations <= 1) return inner;       // short-circuit

const verifierSpec: Model = { ...opts.primaryModel, id: reflect.verifier_model || opts.primaryModel.id };
const verifier = buildModel(opts.env, verifierSpec);
```

The verifier reuses the primary's env + fallback chain but doesn't load tools or judges — it just chats. When `reflect.verifier_model` is empty, the verifier defaults to the primary's id; you usually want it cheaper (e.g. `claude-haiku-4` against a Sonnet primary) to keep the per-iteration cost down.

### invoke()

```
loop i in 0..max_iterations-1:
  result = inner.invoke({ messages: workingMessages })
  if result.final.role != 'assistant': return result   // tool-error terminal, skip verify
  verdict = verify(userGoal, result.final.content)
  audit judge_score (source='reflect', iteration=i, score, critique)
  if verdict.passed: return result
  if i == max_iterations - 1: return result            // exhausted, return as-is
  workingMessages = [
    ...result.messages,
    { role: 'user', content: "[reflect critique, iteration N/MAX] {critique}\n\nRevise your prior response to address this." }
  ]
```

`verify()` calls the verifier model with a system prompt that demands `{"score": <float>, "critique": "<paragraph>"}` JSON output. A thrown verifier (broken binding, network) is treated as pass to avoid infinite loops; the original response stands.

### streamEvents()

v1 delegates to `invoke()` and emits a single `on_chain_end` event. Mid-stream critique relay is follow-on work — would require buffering the inner stream to score, defeating the streaming UX.

### Audit

Each iteration emits a `judge_score` audit event with `payload.source = 'reflect'`, `payload.iteration`, `payload.score`, `payload.critique`. An operator can correlate a flagged manifest's failures with the specific iteration count that triggered the rollback.

## plan_execute

`src/patterns/plan-execute.ts`. Planner/executor split: a planner model decomposes the user goal into an ordered subtask list (JSON), an executor model runs each subtask in a bounded react sub-loop with the manifest's tools, and a final synthesis pass produces the user-facing assistant turn over the accumulated subtask outputs.

### Configuration

```yaml
spec:
  pattern: plan_execute
  model: { id: 'claude-sonnet-4-7' }   # default for both planner + executor
  plan_execute:
    planner_model: ''                  # empty → falls back to spec.model.id
    executor_model: ''                 # same
    max_subtasks: 8                    # hard cap, schema ceiling 20
    replan_on_failure: true
    max_replans: 2                     # 0 = never replan
    executor_recursion_limit: 6        # per-subtask react cap
    planner_few_shots: 3               # 0 = disabled; requires procedural_memory.enabled
  tools: [calculator, memory_recall]   # at least one tool / peer / container required
```

### Initialization

```ts
const planner = buildModel(env, { ...primaryModel, id: planner_model || primaryModel.id });
const synthesizer = planner;   // same client; the synthesis call is its own prompt
const executor = buildReactAgent({
  ...,
  modelSpec:   { ...primaryModel, id: executor_model || primaryModel.id },
  recursionLimit: executor_recursion_limit,   // scoped per-subtask
});
```

Subtask-level recursion is intentionally separate from the manifest's `recursion_limit` so one rogue subtask cannot exhaust the whole budget.

### invoke()

```
0. open the parent session; render prior turns; persist the new caller turn
1. (optional) fetchPlannerFewShots(...)         → preamble of past successful plans
2. callPlanner(userGoal, fewShots, null, convo)  → PlannerReply | null
3. if !plan: emit plan_step(error, 'plan'), return apology message
4. loop:
     for each subtask:
       executor.invoke({ messages: [{ role:'user', content: subtaskPrompt }] })
       emit plan_step(ok|error, subtask.id, payload={ tool_calls, duration_ms })
       if !success: failedSubtask = outcome; break
     if !failedSubtask: break
     if !replan_on_failure or replansUsed >= max_replans: break
     plan = callPlanner(userGoal, fewShots, { plan, critique }, convo)
     emit plan_step(replanned, 'replan_N', subtask_count=...)
5. synthesize(userGoal, outcomes)               → final assistant turn
6. persist the synthesized answer to the parent thread (guard-then-persist)
7. emit plan_step(ok, 'synthesis', subtask_count, replans_used)
```

The parent thread is the persistent entity: `plan_execute` renders prior turns through the `SessionStrategy` and hydrates them into the planner as conversation context, persists the new caller turn up front, and persists the synthesized answer at the end — so a `plan_execute` manifest with `memory.checkpointer: do` is genuinely multi-turn. The executor sub-loops run **stateless** (built with no session store, invoked with no threadId) so per-subtask react loops cannot race-write the parent session DO.

`callPlanner` builds a prompt of `(fewShotsPreamble?, conversationContext?, toolCatalog, subtask cap, priorAttemptCritique?, userGoal)` and asks the planner for `{"plan":[{"id","description","tool_hints?"}], "rationale":"..."}`. `parsePlannerReply` (exported for tests) locates the first balanced `{...}` block, tolerating leading prose and markdown fences. Empty plans, non-array `plan` fields, and subtasks without `description` are rejected.

`runSubtask` calls `executor.invoke` with the subtask description, the original user goal, and a summary of earlier subtask outcomes. A terminal that isn't an assistant turn (fatal tool error, etc.) is treated as failure. An empty assistant turn is also failure — most often the planner asked for impossible work.

### Replans

When `replan_on_failure: true` and the first failing subtask aborts execution, the planner is re-called with the failed plan + critique and replansUsed increments. The second plan starts from scratch (no resume from partial outcomes) — the planner sees the prior attempt and decides what survives. `max_replans` caps how many times this can fire.

### Audit

Every step emits `plan_step` with:

```json
{
  "event_type": "plan_step",
  "status": "ok|error|replanned",
  "payload": {
    "source": "plan_execute",
    "plan_id":  "plan_a1b2c3d4",
    "step_id":  "s1" | "replan_1" | "synthesis" | "plan",
    "executor_model": "<resolved logical id>",
    "tool_calls": ["calculator", "memory_recall"],
    "tool_call_count": 2,
    "duration_ms": 1832,
    "subtask_count": 3,            // on 'plan' / 'replan_N' / 'synthesis'
    "rationale":     "...",         // on 'plan' / 'replan_N'
    "replans_used":  1              // on 'synthesis'
  }
}
```

Counter: `orchestrator_plan_steps { manifest_id, status }`. An operator slicing `status='error'` by `step_id` sees which subtasks tend to fail; slicing `status='replanned'` reveals which manifests need better few-shots.

### Synthesis on failure

Even when the planner fails outright (no parseable JSON ever) the agent still produces a user-facing turn — an apology asking the user to rephrase. When subtasks partially succeed and the plan aborts, the synthesizer runs over the partial outcomes — better to surface what got done than drop the whole turn.

### streamEvents()

v1 delegates to `invoke()` then replays each subtask's tool-call list as synthetic `on_tool_start` / `on_tool_end` pairs followed by one `on_chain_end`. Real mid-plan streaming would interleave deltas from the executor's stream which makes the per-subtask boundary impossible to parse; deferred.

### When to pick `plan_execute` over `reflect`

`reflect` is the right choice when one model call has a chance of being correct and you want quality-via-replay. `plan_execute` is the right choice when the task is genuinely multi-step (research → compare → synthesize, or fetch → transform → summarize) and a single react loop tends to lose the plot mid-run because the model conflates phases. Pair `plan_execute` with `spec.procedural_memory.enabled` so the planner can pull in shapes that worked before.

## Cross-pattern behavior

### threadId discipline

| Pattern | threadId behavior |
|---|---|
| react / deep / reflect | Opens a `Session` keyed by `${tenantId}:${suffix}`, renders via `SessionStrategy`, and appends new events as they're produced. |
| router | Forwards threadId to the chosen child. |
| parallel | Parent owns the transcript: renders prior turns, persists the new caller turn + synthesized answer to the parent threadId. Strips threadId before fan-out (children are stateless this run — they see the hydrated transcript but race-write nothing). |
| groupchat | Parent owns the transcript: renders + appends to the `Session` for the parent threadId, deliberately does **not** forward threadId to children (they would race-write the same DO). |
| plan_execute | Parent owns the transcript: renders prior turns into the planner as context, persists the new caller turn + synthesized answer to the parent threadId. Each executor subtask runs stateless (no session store, no threadId) so per-subtask react sub-loops cannot race-write the parent session DO. |

### Deny-string contract

Governance wrappers return human-readable deny strings instead of throwing. The model sees the deny in the tool result and can either retry with different arguments, abandon the tool, or surface the limitation to the user. The wrappers never throw, so the loop never aborts on a single denied call.

### Sequential tool dispatch

The react loop dispatches tools sequentially even when the model emits multiple tool_calls in one turn. This is intentional: audit ordering is deterministic, governance state mutations (limit counters, approval lookups) are serialized, and a denial on the first call can short-circuit the rest. Parallelizing would complicate audit replay and double-spend the `peer_hops` budget.

### Recursion bound

`recursion_limit` (default 10, ceiling 50) bounds the react/deep loop. The limits wrapper (`max_tool_calls`, `max_wall_clock_seconds`, `max_peer_hops`) provides orthogonal bounds — recursion limit caps loop **steps**, limits cap aggregate **work** across the run.

### Durable execution wrap

`spec.execution.mode: durable` wraps the builder's resulting `Agent` in a `DurableAgent` (`src/manifests/builder.ts:wrapDurableAgent`) that, on `invoke`:

1. Pulls the current `RequestContext` and packages `{tenantId, principalSubject, manifestId, threadId, messages}` as the Workflow params.
2. Calls `env.AGENT_WORKFLOW.create({ params })` and polls instance status until `complete` / `errored` / `terminated`.
3. The poll loop honors the request-scope abort signal — if the request unwinds, the wrapper throws but the Workflow continues independently (clients reconnect via A2A `tasks/resubscribe`).
4. On `complete`, parses the workflow's JSON-encoded output back to `InvokeResult` (Workflows' `Serializable<T>` constraint rejects our recursive message shapes, so the workflow `JSON.stringify`s and the wrap `JSON.parse`s).

Inside the `AgentWorkflow.run()`, the manifest is re-resolved with `execution.mode` forced to `transient` to break the recursion cycle. The agent runs inside `step.do('agent-invoke', { retries: 3, delay: '5 seconds', backoff: 'exponential', timeout: '15 minutes' }, ...)` so a worker eviction mid-run replays the step rather than losing the branch.

Binding-graceful: when `env.AGENT_WORKFLOW` is absent (dev probes, unit tests), the wrap logs an `orchestrator_durable_fallback` counter and delegates straight to the inner agent.
