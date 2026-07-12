---
description: "Five governance layers — policies, limits, guardrails, LLM judges, approvals — compose at build time and run on every tool invocation."
---

# Governance

Felix applies five governance layers to every tool call: policies, limits, guardrails, llm_judge, approvals. They compose at build time and run on every invocation. A federated `PolicyBundle` overlays manifest-declared policies and approvals.

## Composition

`buildAgent` step 10 ([src/manifests/builder.ts](../../src/manifests/builder.ts)):

```ts
const merged = mergeWithManifest(manifest.spec.policies, manifest.spec.approvals);

if (merged.policies.length)              tools = applyPolicies(tools,    merged.policies,   manifestId);
if (anyLimit(manifest.spec.limits))      tools = applyLimits(tools,      manifest.spec.limits, manifestId);
if (guardrailsEnabled(guardrails))       tools = applyGuardrails(tools,  guardrails,        manifestId);
if (judgesEnabled(guardrails))           tools = applyJudges(tools,      guardrails,        manifestId);
if (merged.approvals.length)             tools = applyApprovals(tools,   merged.approvals,  manifestId);
```

Each wrapper rewrites the tools array, returning new `Tool` objects whose `executor` delegates to the inner one. The wrappers use `wrapExecutor(inner.executor, ...)` from [src/tools/executor.ts](../../src/tools/executor.ts), which preserves the inner `transport` label (`local` / `mcp` / `a2a` / `container` / `queue` / `sandbox` / `browser`) so audit and observability can still report the true transport after composition. The order of application determines the runtime stack:

```
model call -> tool dispatch
            -> Approvals     (gate)
            -> LLM Judge     (post-call score)
            -> Guardrails    (filter)
            -> Limits        (cap)
            -> Policies      (scope-check)
            -> inner tool
```

Read top-to-bottom for the call direction; bottom-to-top for which layer was applied first at build time.

## Deny-output contract

Every wrapper returns its deny via `denyOutput(content, source)` from [src/tools/types.ts](../../src/tools/types.ts) — they never throw. The model sees the `content` string in the tool result and can adapt: retry with different args, try a different tool, or surface the limitation to the user. Throwing would abort the loop and lose context.

The marker (a module-private `Symbol` stamped on `metadata`, plus `metadata.source`) lets outer wrappers detect inner denies via `isWrapperDeny(output)`. The guardrails output filter uses this to short-circuit — without it, a policy/approval/limit deny string would get re-scanned and possibly redacted. The marker is deliberately **not** a public string key: a tool executor returns an arbitrary `{ content, metadata }` object, so a string flag would let a malicious/buggy tool forge a wrapper-deny — exempting its own output from guardrail/judge filtering and suppressing its `tool_call` audit row. Only `denyOutput` (wrapper code) can reference the symbol, so the marker is unforgeable by tools.

:::caution[New post-call wrappers must check `isWrapperDeny`]
When writing a new wrapper that does **post-call** work (output filtering, scoring, transformation), check `isWrapperDeny(out)` first and pass the deny through verbatim. Missing this check causes outer wrappers to double-process an inner deny as if it were a normal tool result.
:::

## Fatal tool errors

Tools may declare `fatal: true` when constructing via `defineTool({ ..., fatal: true })` or `defineToolWithExecutor({ ..., fatal: true })`. By default, an exception thrown from `tool.executor.execute(...)` is stringified as `[tool error] <msg>` and fed back to the model so it can recover. With `fatal: true`, the react loop terminates immediately with the tool error message as `final` — the model never sees the failure.

:::caution[Use `fatal: true` sparingly]
Reasonable cases:
- Hard quota exhaustion that won't recover within the run.
- Security violations the model should not be allowed to retry around.
- Configuration errors that mean the tool is unusable for the entire request.

Recoverable conditions (a flaky API call, a transient lookup miss, malformed args) should stay non-fatal so the model can adapt. Overusing `fatal: true` prevents the model from recovering from transient failures.
:::

## Cancellation via ctx.signal

:::tip[Always thread `ctx.signal` through outbound work]
Without `signal`, the wall-clock check only blocks the *next* tool call — a long-running fetch already in-flight runs to completion and holds an isolate slot. Pass the signal through to honour wall-clock caps correctly.
:::

The per-request `LimitState.abortController` fires when the wall-clock cap elapses or the request is torn down. Patterns inject `signal` into `ToolInvocationCtx`; the executor receives it and tool authors should pass it through to outbound work:

```ts
defineTool({
  name: 'fetch_thing',
  description: '...',
  args: z.object({ url: z.string() }),
  async handler({ url }, ctx) {
    const resp = await fetch(url, { signal: ctx?.signal });
    return await resp.text();
  },
});
```

Without `signal`, the wall-clock check only blocks the *next* tool call — a long-running fetch already in-flight runs to completion. With it, AbortError surfaces and the tool returns the catch-block output (e.g. `[cancelled] ...`). The built-in non-local executors — `A2AExecutor` ([src/a2a/client.ts](../../src/a2a/client.ts)), `McpExecutor` ([src/mcp/client.ts](../../src/mcp/client.ts)), and `ContainerExecutor` ([src/tools/container-executor.ts](../../src/tools/container-executor.ts)) — already plumb the signal through to their outbound fetches; custom tools and custom executors that fetch external services should match the pattern.

## Policies

Source: `src/policy/wrap.ts`, `src/policy/models.ts`.

A policy declares required scopes on a set of tools:

```yaml
policies:
  - id: write-paths
    description: Writes need explicit grant
    required_scopes: ["data:write"]
    tools: ["create_record", "update_record"]
```

When a wrapped tool is invoked, the wrapper reads `principal.scopes` from the AsyncLocalStorage context and AND-checks every applicable policy:

```
principalScopes = ctx.auth.principal.scopes (Set<string>)
missing = policy.required_scopes.filter(s => !principalScopes.has(s))
if missing.length: emit policy_decision audit (denied), return deny string
```

When a tool appears in multiple policies, **all** must pass.

**Tool targeting matches by glob, not just exact name** (`src/tools/tool-match.ts`, shared by policies, approvals, and judges). A `tools` / `target_tools` entry is either an exact name, a trailing-`*` prefix (`stripe__*`), or a bare `*` (all tools). This closes an MCP gap: MCP tools are named `${serverName}__${remoteToolName}` where the remote server chooses the suffix, so exact-name targeting let a malicious server dodge a policy/approval/judge by renaming its tools. The `serverName` prefix comes from the manifest's `mcp_servers[].name` (server-proof), so `stripe__*` gates the entire server regardless of what it names its tools.

Audit event:
```json
{ "event_type": "policy_decision", "status": "denied",
  "payload": { "policy_id": "...", "tool": "...", "missing_scopes": [...], "outcome": "denied" } }
```

Counter: `orchestrator_policy_decisions { outcome, policy_id, manifest_id }`.

## Limits

Source: `src/limits/wrap.ts`, `src/limits/models.ts`, `src/limits/state.ts`.

Manifest declares per-run caps:

```yaml
limits:
  max_tool_calls: 40            # ceiling: 200
  max_wall_clock_seconds: 120   # ceiling: 600
  max_peer_hops: 2              # ceiling: 5
  max_input_tokens: 100000      # ceiling: 1_000_000
  max_output_tokens: 8000       # ceiling: 100_000
```

Absolute ceilings (`ABSOLUTE_LIMITS` in [src/limits/models.ts](../../src/limits/models.ts)) apply even if the schema is bypassed — `applyLimits` and `checkTokenBudget` run every declared cap through `clampLimits` before enforcing, so a `Limits` object built without Zod (a test harness or future programmatic builder) can't exceed the ceiling. `null` caps stay `null` (no manifest-level cap):

| Cap | Ceiling |
|---|---|
| `max_tool_calls` | 200 |
| `max_wall_clock_seconds` | 600 |
| `max_peer_hops` | 5 |
| `max_input_tokens` | 1,000,000 |
| `max_output_tokens` | 100,000 |
| `recursion_limit` | 50 |
| `max_turns` | 20 |

`null` in the manifest means "no manifest-level cap"; the absolute ceiling still applies.

### State

`LimitState` lives on `RequestContext.limitState` (installed by auth middleware, torn down via `disposeLimitState` in `finally`):

```ts
{
  toolCalls: 0,
  peerHops: 0,
  startedAt: Date.now(),
  auditCount: 0,
  auditTruncatedEmitted: false,
  abortController: new AbortController(),  // fires on wall-clock breach or teardown
  wallClockTimerId?: setTimeout(...),       // armed on first wrapped call
  tokens: { input: 0, output: 0 },          // accumulated by patterns/model.ts:recordUsage
}
```

Tool wrappers read it through `currentLimitState()` ([src/limits/state.ts](../../src/limits/state.ts)). Because it's AsyncLocalStorage-bound, no parameter threading is needed and tool authors cannot tamper with it.

### Check order

Per invocation, before incrementing:

1. Wall clock: `(Date.now() - state.startedAt) / 1000 > max_wall_clock_seconds`
2. Tool calls: `state.toolCalls >= max_tool_calls`
3. Peer hops: `(inner.isPeer || inner.name.startsWith('peer_')) && state.peerHops >= max_peer_hops`

On any breach: return `denyOutput(...)` (content `[limit exceeded] <name> cap of <cap> reached at tool '<tool>'`), emit `limit_exceeded` audit event, do not increment.

On pass: increment `toolCalls` (always) and `peerHops` (peer tools only). Inject `state.abortController.signal` into `ctx.signal` so the tool sees cancellation if wall-clock fires mid-call.

Counter: `orchestrator_limit_breaches { limit, manifest_id }`.

### Token caps

Token caps live on the same `Limits` block but are **not** checked by the per-tool wrapper — tools don't accrue tokens, model calls do. Patterns run two checks immediately before each `model.chat` / `model.streamChat`:

1. `checkPreflightTokenBudget(model, messages, tools, limits, manifestId)` — gated by `limits.precount` and `max_input_tokens` and only effective when the route implements `countTokens`. Anthropic's free `/v1/messages/count_tokens` projects the next call's input; if `state.tokens.input + projected >= max_input_tokens`, the call is denied before any paid request is made. Count failures are swallowed (the post-call check picks up the slack).
2. `checkTokenBudget(limits, manifestId)` — compares the cumulative `state.tokens.input` / `state.tokens.output` against `max_input_tokens` / `max_output_tokens`.

Call sites in [src/limits/wrap.ts](../../src/limits/wrap.ts):

- `react.ts` / `deep.ts` — before every loop iteration's model call (both `invoke` and `streamEvents`).
- `router.ts` — before the classifier call (falls back to first sub-agent if budget blown).
- `parallel.ts` — before the aggregator call (returns the deny as the final message).

`recordUsage(result, { manifestId, modelId })` in [src/patterns/model.ts](../../src/patterns/model.ts) accumulates `result.usage` onto `state.tokens.input` / `state.tokens.output`. Cache reads and cache creations still occupy the request's input context window, so they count against `max_input_tokens` — `state.tokens.input += input + cache_creation + cache_read`. The OpenAI client subtracts `cached_tokens` from `prompt_tokens` before reporting `usage.input`, matching the Anthropic shape so cached tokens don't double-count. Per-kind counters (`orchestrator_tokens { manifest_id, model, kind ∈ input | output | cache_creation | cache_read }`) capture the cost split for observability. Sub-agents share the parent's `LimitState`, so token spend in a fan-out aggregates across everyone.

### Wall-clock abort timer

`armWallClockAbort(state, limits, manifestId)` ([src/limits/wrap.ts](../../src/limits/wrap.ts)) is idempotent — only the first wrapped call per request schedules the timer. When it fires, `state.abortController.abort(...)` cancels in-flight `fetch` calls that have `ctx.signal` plumbed through. Without the timer, a long-running tool past the budget would run to completion; only the *next* call would see the breach.

`disposeLimitState` in [src/context.ts](../../src/context.ts) is the cleanup hook — clears the timer, fires abort if it hasn't already. Auth middleware calls it in `finally`; cron + queue handlers do the same in [apps/api/src/index.ts](../../../../apps/api/src/index.ts).

### Audit truncation

`limitState.auditCount` tracks audit events per request; cap is 200. On hit, one `audit_truncated` event with `payload: { reason, cap }` is emitted (`auditTruncatedEmitted` flips), and further events are silently dropped. Defends against runaway loops bloating the queue.

## Guardrails

Source: `src/guardrails/wrap.ts`, `src/guardrails/pipeline.ts`, `src/guardrails/models.ts`.

```yaml
guardrails:
  providers: [pii]              # currently: "pii", "bedrock" (placeholder)
  block_on_match: false         # true -> deny; false -> redact and continue
  targets: [input, output]      # which side(s) of the call to filter
```

### PII redactor

Four regex patterns (`src/guardrails/pipeline.ts:21-38`):

| Name | Pattern |
|---|---|
| `email` | `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` |
| `ssn` | `\b\d{3}-\d{2}-\d{4}\b` |
| `phone` | `\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b` |
| `credit_card` | `\b(?:\d[ -]*?){13,16}\b` |

Hits are replaced with `[REDACTED:<name>]`. For each hit, an audit `Match` is recorded with a **fingerprint only** — SHA-256 of the matched text truncated to the first 8 hex bytes. The raw value never goes to audit.

### Bedrock placeholder

`bedrockFilter` returns the input unchanged. Reserved for a future AI Gateway content policy hook; including it in `providers: [bedrock]` is a no-op today.

## LLM Judge

Source: `src/guardrails/judge-wrap.ts`, `src/guardrails/models.ts`.

```yaml
guardrails:
  judges:
    - name: relevance
      threshold: 0.7                                   # default 0.7; pass floor
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast'  # optional; this is the default
      criteria: |
        response should be on-topic and directly answer the tool input
      target_tools: ['fetch_page', 'page_links']       # optional; empty = all tools
```

Composed *after* guardrails (`applyJudges(tools, guardrails, manifestId)`) so judges score a result that has already been redacted/filtered. Each applicable judge calls `env.AI.run(rule.model, { messages: [...] })` once per matching tool call (native binding — no AI Gateway hop) with the tool name, args (sliced to 500 chars), output (sliced to 2000 chars), and the `criteria` string. The judge model is expected to return JSON `{"score": <float>, "reasoning": "<text>"}`.

Judges only run on a clean inner result — outputs already flagged via `isWrapperDeny` (a deny from policy/limits/guardrails/approvals) or carrying a tool-error code are passed through untouched. Applicable judges run in order; the **first** below-threshold judge short-circuits to a deny.

Per-judge behavior:

- Every score emits a `judge_score` audit event with `status: 'pass' | 'fail'` and `payload: { judge, tool, transport, score, threshold, reasoning }` (`reasoning` truncated to 500 chars). There is no `source` field on the payload.
- When `score < threshold` the wrapper returns `denyOutput('[judge denied] tool '<name>' failed judge '<judge>' (score <s> < <threshold>): <reasoning>', 'guardrails')` — the deny is sourced as `'guardrails'`, and the model sees the deny and adapts (the inner result is dropped). Below-threshold always denies; there is no score-only mode.

Failure handling: a missing `env.AI` binding returns `null` → the judge is **skipped** (treated as a pass) and `orchestrator_judge_skipped { reason, judge, manifest_id }` increments. A model-call error or an unparseable reply, however, yields `passed: false` with score 0, so the result is **denied** (a model error increments `orchestrator_judge_error { judge, manifest_id }`); only the absent-binding case fails open.

Counter: `orchestrator_judge_scores { judge, tool, verdict, manifest_id }` (`verdict ∈ pass | fail`).

The `reflect` pattern also emits `judge_score` audit events, but tags them with `payload.source: 'reflect'` (`src/patterns/reflect.ts`) so an operator can distinguish a reflect verifier score from a guardrails-judge score — the guardrails judge omits `source` entirely.

### Wrap behavior

For each invocation:

```
if targets.includes('input'):
  for each string arg: run all providers
  if matches:
    audit guardrail_block { surface: 'input', matches }
    if block_on_match: return deny string
    else: replace arg with filtered

invoke inner tool
if out is string and targets.includes('output'):
  run all providers on out
  if matches:
    audit guardrail_block { surface: 'output', matches }
    if block_on_match: return deny string
    else: replace string with filtered
```

Counter: `orchestrator_guardrail_blocks { surface, manifest_id }`.

### Final-response guard

The wrapper above only sees **tool traffic**. The model's final user-facing answer isn't a tool call, so it's filtered by a separate hook — `guardFinalResponse` ([src/guardrails/final-response.ts](../../src/guardrails/final-response.ts)) — invoked by the react / deep / reflect / plan_execute loops at the terminal message, **outside** the executor wrapper chain (it operates on the assistant `ChatMessage.content`). It runs only when `guardrails.targets` includes `final_response` and there is at least one provider.

```
at the loop's terminal assistant turn:
  if targets.includes('final_response') and providers:
    run all providers on message.content
    if matches:
      audit guardrail_block { surface: 'final_response', matches }   # fingerprints only
      on_match == 'block' ? replace whole answer with a notice : replace content with filtered
```

Streaming has three modes. `buffer` holds deltas back, filters the completed answer, and emits the guarded text as one chunk (correct, costs TTFT). `incremental` streams filtered deltas live, holding back a bounded tail (`SAFE_TAIL_CHARS`, ~320) so a match spanning a chunk boundary is caught before its bytes are emitted — a single contiguous secret longer than the window could leak its prefix. `passthrough` streams deltas raw and only guards the persisted terminal message, emitting `orchestrator_final_guard_skipped { reason: 'streaming_passthrough' }`. Content-filter redaction works under all three, but `on_match: 'block'` cannot be combined with `incremental` — the filtered deltas have already streamed, so validation rejects the pair rather than silently downgrading block to redact (`passthrough` still blocks the persisted/returned copy). A `final_response` judge can only BLOCK under `buffer` / non-streaming (the others have already sent bytes — incremental emits `orchestrator_final_guard_skipped { reason: 'streaming_incremental_judge' }` when a judge retroactively blocks). Only `content` is touched — `thinking` / `redacted_thinking` blocks are preserved.

Multi-agent coverage: **parallel** guards the aggregator's synthesized answer. **groupchat** filters every speaker turn — the whole transcript is returned to the caller and persisted to the session log, so intermediate turns are not internal — and runs the full final-response guard on the last turn, before persisting (guard-then-persist, matching react). Both use the parent manifest's guardrails. **router** is a pass-through — it forwards the chosen sub-agent's response verbatim (post-filtering a forwarded stream would mean buffering the whole child stream), so final-response guarding for a router is delegated to the sub-agent manifests, which run their own guard.

A judge flagged `final_response: true` scores the answer here too, after the content filter — a below-threshold score blocks (replaces the answer with the notice) and emits `judge_score { source: 'final_response' }`. Judges need the full answer, so they block only on the non-streaming path and streaming `buffer` mode; under `passthrough` the bytes have already streamed. The tool-side `applyJudges` skips `final_response` judges. In groupchat, judges run once — on the final turn; intermediate speaker turns get the content filters only.

A `fatal: true` tool error is also a terminal answer — the react loop runs the same guard over the fatal message before it's returned, streamed (`on_tool_end` included), or persisted, since upstream error bodies can carry secrets. Intermediate (non-terminal) assistant text in `buffer` mode is still flushed unguarded — only the terminal answer is covered.

## Approvals

Source: `src/approvals/wrap.ts`, `src/approvals/store.ts`, `src/approvals/approvals-do.ts`, `src/approvals/models.ts`.

```yaml
approvals:
  - id: production-writes
    description: All writes require approval
    tools: ["create_record", "update_record"]
```

### First invocation

1. Parse args through the tool's Zod schema (rejects unknown keys, normalizes order).
2. Compute deterministic call signature:
   ```
   callSignature = SHA-256(`${manifestId}|${toolName}|${canonicalize(args)}`)
   ```
   `canonicalize` sorts keys before stringifying so semantically-equivalent args hash the same.
3. `findBySignature(env, tenantId, manifestId, toolName, callSignature)` — D1 lookup using the unique index `uq_approval_signature`.
4. On miss: `INSERT` an `approvals` row with `status='pending'`, `args_json = redactSecrets(args)`. Emit `approval_request` audit (`status: pending`). Return deny string to the model:
   ```
   [approval required] tool '<name>' requires human approval. approval_id=<uuid>. Retry later with the same arguments.
   ```

### Decision

`POST /approvals/:id/decide` routes through `ApprovalsDO` (`src/api/approvals.ts`):

1. Pre-check tenant ownership in D1 (return 404 if not owned; avoid locking the DO on a probe).
2. `approvalsDoStub(env, tenantId, id).fetch('https://do/decide', { ... })` — the DO uses `blockConcurrencyWhile` so concurrent decisions serialize.
3. The DO calls back into `decideRequest()` which updates the D1 row.
4. Emit `approval_decision` audit (`status: approved` or `status: denied`).

The DO is a critical section, not the system of record. D1 is the source of truth.

### Retry

When the model retries with the same args:

- Signature hashes to the same value.
- Lookup returns the existing row.
- If `status='approved'`: emit `approval_decision` (approved), use `edited_args_json` if set otherwise original `args`, call through to the inner tool.
- If `status='denied'`: emit `approval_decision` (denied), return deny string with `decision_note`.
- If `status='pending'`: same deny string as first invocation. The unique index guarantees no duplicate row is inserted.

Counters:
- `orchestrator_approval_requests { manifest_id }`
- `orchestrator_approval_decisions { outcome, manifest_id }`

## Federation

Source: `src/policy/bundle.ts`, `src/policy/federation-do.ts`.

A central authority ships a signed `PolicyBundle` to R2:

```json
{
  "version": "2026.05.13-01",
  "issuer": "felix-federation",
  "policies": [{ "id": "...", "required_scopes": [...], "tools": [...] }],
  "approvals": [...],
  "signature": "<base64 Ed25519>"
}
```

### Lifecycle

1. **Authoring** — author bundle JSON, sign deterministically (key-sorted JSON with `signature` removed) with the Ed25519 private key whose public key is in `POLICY_BUNDLE_PUBKEY`.
2. **Upload** — `wrangler r2 object put` to the bucket at `POLICY_BUNDLE_KEY`.
3. **Refresh** — every 10 minutes the worker cron fires `federationStub(env).fetch('https://do/refresh')`. The `FederationDO` pulls from R2, verifies the signature, and updates its cached bundle and `refreshedAt`.
4. **Verification** — `crypto.subtle.verify({ name: 'Ed25519' }, key, sig, target)` against the JSON-with-signature-removed key-sorted form.
   - Staging/production: signature mismatch keeps the previous active bundle in place; an unsigned bundle is rejected.
   - Development: signature failures log a warning and load anyway.
5. **Process-local cache** — `syncFederationCache(env)` populates an in-isolate variable read by `getActiveBundle()` on the hot path so the DO isn't hit per request.

### Merge semantics

`mergeWithManifest(manifest.policies, manifest.approvals)` (`src/policy/bundle.ts`):

- Manifest's policies and approvals are loaded first into a `Map` by id.
- Bundle policies are loaded second; **bundle wins on id collision** — a central revocation cannot be silently disabled by a manifest authoring a policy with the same id.
- Bundle-side approvals have a passthrough (`z.unknown()`) shape today, so they are **not cross-merged** with manifest approvals — only the manifest's approval rules survive into the wrapped tool stack.

## Wrapping summary

| Layer | Reads | Decision | On fail | Audit | Counter |
|---|---|---|---|---|---|
| Policies | `principal.scopes` | scope AND-check | deny string | `policy_decision` | `policy_decisions` |
| Limits | `LimitState` | wall_clock / tool_calls / peer_hops / tokens | deny string | `limit_exceeded` | `limit_breaches` |
| Guardrails | filter providers | regex hits / placeholder | deny or redact | `guardrail_block` | `guardrail_blocks` |
| LLM Judge | `env.AI` criteria score | score < threshold | deny string | `judge_score` | `judge_scores` |
| Approvals | D1 status + call signature | pending/approved/denied | deny string | `approval_request`, `approval_decision` | `approval_*` |

Every wrapper's audit row and counter row carry the inner tool's `transport` (`local` / `mcp` / `a2a` / `container` / `queue` / `sandbox` / `browser`) as a payload field / label, so an operator can slice "policy denies by transport" or "approval requests for `container` tools." The transport label survives wrapping because each wrapper uses `wrapExecutor(inner.executor, ...)` (see [src/tools/executor.ts](../../src/tools/executor.ts)), which preserves the inner `transport` on the new outer executor — so `inner.executor.transport` is always available at audit/counter time.
