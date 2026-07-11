---
description: "Every field in the orchestrator/v1 manifest schema with defaults, types, ceilings, and examples."
---

# Manifest Reference

Every field in the `apiVersion: orchestrator/v1` manifest schema. Source of truth: `src/manifests/schema.ts` plus cross-field rules in `src/manifests/validate.ts`.

All objects are `.strict()`, so any unknown key is a parse error. Where a field has a default, the default is what you get if you omit it.

## Top-level shape

```yaml
apiVersion: orchestrator/v1   # default; only this exact value is accepted
kind: Agent                   # default; only this exact value is accepted
metadata: { ... }             # required
spec: { ... }                 # defaults to a minimal react agent
```

## metadata

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string (1-128 chars, `[a-zA-Z0-9._-]`) | required | Used as the manifest id, the OpenAI `model` value, the audit `manifest_id`, and an R2 override object-key segment. Restricted to `[a-zA-Z0-9._-]` (no slashes or whitespace) so it can't escape its key prefix. |
| `version` | string | `"1.0.0"` | Free-form. |
| `description` | string | `""` | Surfaced in the A2A agent card. |
| `tags` | string[] | `[]` | Free-form. |

## spec.pattern

```yaml
pattern: react | deep | router | parallel | groupchat | reflect | plan_execute   # default: react
```

- **react** / **deep** — single-agent. Tool loop. `deep` adds planning tools.
- **router** / **parallel** / **groupchat** — multi-agent. Require `sub_agents`; forbid `peers`, `containers`, `queues`, `sandboxes`, `browser_tools`.
- **reflect** — single-agent. Wraps a react loop with a verifier model that scores each final response against `spec.reflect.criteria`; below threshold the critique is appended as a synthetic user turn and react replays up to `spec.reflect.max_iterations`. See [internals/patterns.md](../internals/patterns.md#reflect).
- **plan_execute** — single-agent planner/executor split. Decomposes the user goal into a JSON plan, runs each subtask through the executor model in a bounded react sub-loop, optionally re-calls the planner on failure. Configure via `spec.plan_execute` (see below). Requires at least one tool / peer / container — bare-chat plan_execute is rejected at validate time.

## spec.model

```yaml
model:
  id: claude-sonnet-4        # default: null -> falls back to env.DEFAULT_MODEL_ID
  temperature: 0             # default: 0
  max_tokens: 1024           # default: null (provider default)
  region: null               # default: null (advisory; not currently routed on)
  cache: false               # default: false; Anthropic prompt caching (cache_control: ephemeral)
  thinking_budget: null      # default: null; Anthropic extended thinking, min 1024, max 64000
  fallbacks: []              # default: []; ordered list of logical model ids to try on provider_error
  confidence_escalation:
    enabled: false           # default: false
    escalate_to: ""          # default: ""; logical model id used on low-confidence escalation
    low_confidence_markers:  # default: ['i am not sure', "i don't know", ...]
      - "i am not sure"
    min_response_chars: 40   # default: 40; responses shorter than this also escalate
```

The `id` is a **logical** id resolved through `MODEL_ROUTES` (a JSON map in env vars) to `{ provider, model }`. See [deploy.md](deploy.md) for examples.

`cache: true` tags the system prompt, the last tool definition, and the last conversation message with `cache_control: ephemeral` on Anthropic-routed calls so subsequent turns read those prefixes from Anthropic's prompt cache (~10% input cost, lower TTFT). No-op on OpenAI / Workers AI — OpenAI prompt caching is automatic and surfaces via `cached_tokens` regardless of this flag.

`thinking_budget` enables Anthropic extended thinking when non-null. The request includes `thinking: { type: 'enabled', budget_tokens: N }`; temperature is forced to 1 (Anthropic requirement); `max_tokens` is bumped to at least `budget + 1024`. Returned `thinking` content blocks are captured on the assistant message and echoed back on the next request — Anthropic rejects tool-result follow-ups that drop the preceding thinking blocks. No-op on OpenAI / Workers AI.

`fallbacks` is an ordered list of logical model ids tried when the primary returns a `provider_error` (HTTP 5xx, 408, 429, network failure). Each fallback resolves through the same `MODEL_ROUTES`; a successful fallback emits a `model_switch` audit event with `from`, `to`, `reason: 'provider_error'`. 4xx and AbortError are NOT retried.

`confidence_escalation` (when `enabled: true` AND `escalate_to` is set) re-calls the model at `escalate_to` when the primary's response either matches a `low_confidence_markers` substring OR is shorter than `min_response_chars`. Emits `model_switch` with `reason: 'low_confidence'`. Streaming passes through unwrapped (buffering the stream to score defeats the streaming UX).

## spec.system_prompt

```yaml
system_prompt:
  inline: ""                 # default: ""
  soul: false                # default: false; true loads from deps.soulLoader(tenantId)
  base: ""                   # default: ""
```

Parts are joined with `"\n\n---\n\n"` in the order **soul → base → inline** (`resolveSystemPrompt` in `src/manifests/builder.ts`). Empty parts are dropped. If all parts are empty the builder falls back to `"You are <name>. Use your tools when needed to answer accurately."`.

## spec.tools

```yaml
tools: []                    # default
```

List of tool names registered with the `ToolProvider`. The core built-ins are `calculator`, `list_skills`, `activate_skill`, `deactivate_skill`, plus the commerce suite registered in `apps/api/src/composition.ts`: catalog/cart/order tools (`catalog_search`, `catalog_get`, `catalog_categories`, `cart_view`, `cart_add`, `cart_update`, `cart_remove`, `order_status`), `commerce_checkout`, `commerce_record_consent`, personalization (`recommend_products`, `identify_customer`), visual search (`search_by_image`), and the B2B suite (`account_get`, `buyer_get`, `purchase_authority_check`, `price_lookup`, `create_quote`, `quote_get`, `send_quote`, `accept_quote`, `convert_quote`, `invoice_get`, `pay_invoice`) — see [Agentic commerce](../../../commerce/docs/index.md). Skills can fold additional tool names into this list at build time.

## spec.skills

```yaml
skills:
  - name: research           # required
    version: null            # default: null
```

References to bundled `SKILL.md` files. Each skill's frontmatter contributes tools, MCP server names, and A2A peer names, and its Markdown body is appended to the system prompt under a `## Active Skills` header. Skill activation is per-tenant and restriction-only.

## spec.mcp_servers

```yaml
mcp_servers:
  - name: weatherapi              # required
    url: https://mcp.example.com  # required; SSRF-guarded (https, non-private)
    auth: ""                      # default: ""; "cf-access" or a bearer token marker
    transport: sse                # default: sse; "http" | "sse" | "stdio"
```

URLs go through `assertSafeOutboundUrl` at parse time — `http://` is rejected except in development, and private-range IPs / `.internal` / `.cluster.local` hosts are blocked unless added to `SSRF_ALLOW_HOSTS`. Each tool from a server is namespaced as `${name}__${toolName}`. A remote server is a **trust boundary**: its tool `description` and `inputSchema` are injected into the model's tool definitions (a prompt-injection surface), so the description is length-capped, an oversized schema is dropped, and the build-time `tools/list` discovery call is bounded by a timeout.

## spec.peers

```yaml
peers:
  - name: billing                 # required
    url: https://peer.example.com # required; SSRF-guarded
    auth: ""                      # default: ""
```

Each peer becomes a `peer_${name}` tool that delegates via A2A `tasks/send`. The `peer_` prefix is significant: the limits wrapper detects it (or `isPeer: true`) and increments `peerHops`.

## spec.containers

```yaml
containers:
  - name: python_runner                                    # required; the tool name the model sees
    description: "Run Python in a sandbox"                 # default: ""
    gateway_url: https://sandbox.felix.run/run             # required; SSRF-guarded (https, non-private)
    image: ghcr.io/felix/python-3.12:latest                # required; image / sandbox identifier
    container_tool_name: ""                                # default: "" → falls back to `name`
    timeout_ms: 30000                                      # default: null (no per-call cap)
    auth: ""                                               # default: ""; marker passed to the credential broker
    args_schema: null                                      # default: null; optional JSON Schema advertised verbatim
    fatal: false                                           # default: false; true ends the loop on transport errors
```

Each entry becomes a `Tool` whose executor is a `ContainerExecutor` (`transport: container`). The brain–hands seam: the model sees `execute(name, input) → string`; the harness routes the call to the declared gateway so untrusted work runs in isolation.

Gateway contract:

```
POST {gateway_url}
{ "image": "<image>", "tool": "<container_tool_name>", "arguments": { ... } }

200 { "content": "...", "exit_code"?: number, "stderr"?: string }
non-2xx       → "[container error] <image>: <status> <body>"
exit_code N≠0 → "[container exit N] <tool>: <stderr|content>"
```

Credentials never enter the sandbox by default. When `auth` is set, the executor asks the credential broker (`AuthContext.outboundToken({ name, auth, url })`) for an `Authorization` header on the gateway request — the value is added to the request, never to `arguments`. Inviting a token *into* the container is a manifest-author choice, not a default.

Cancellation honors both `ctx.signal` (request-scope abort: wall-clock breach, request teardown) and the per-call `timeout_ms` watchdog; either source aborts the in-flight gateway fetch.

Containers are **forbidden** when `pattern ∈ {router, parallel, groupchat}` — the same way `peers` are. Multi-agent patterns supervise children; tools (including container-backed ones) belong on the leaf manifests.

## spec.queues

```yaml
queues:
  - name: long_research                                    # required; tool name the model sees
    description: "Kick off a long-running research job"    # default: ""
    queue_binding: JOBS_QUEUE                              # required; binding name in wrangler.jsonc
    deadline_ms: 60000                                     # default: null (no advertised deadline)
    args_schema: null                                      # default: null; optional JSON Schema advertised verbatim
    fatal: false                                           # default: false; true ends the loop on enqueue failure
```

Each entry becomes a `Tool` whose executor is a `QueueExecutor` (`transport: queue`). Calling the tool enqueues a job and returns a chatty stub mentioning the `job_id` and `tasks/resubscribe`; the model is expected to relay that to the user.

`queue_binding` is the Worker binding name (under `wrangler.jsonc`'s `queues.producers[]`) the executor sends to. The builder resolves it against `env[binding]` at build time — a missing or wrong binding fails the build so a misconfigured manifest never silently no-ops at request time.

**Resume protocol.** The consumer side (a separate Worker reading from the same queue, deliberately not part of Felix) does the work and writes a `kind: 'tool_result'` event back to `ConversationDO` keyed by `thread_id`, with the dispatched `tool_call_id` as the rendezvous key. When the client reconnects via `tasks/resubscribe`, `session.wake()` reports the cycle resolved and the next model step renders the new `tool_result` through the strategy. See [`docs/internals/persistence.md#async-tool-resumption-queue-transport`](../internals/persistence.md#async-tool-resumption-queue-transport) and [`examples/queue-consumer/`](../../examples/queue-consumer/) for the consumer-side shape.

Queue tools are **forbidden** when `pattern ∈ {router, parallel, groupchat}`, same as containers and peers.

## spec.sandboxes

```yaml
sandboxes:
  - name: code_exec                                  # required; tool name the model sees
    description: "Run code in a sandbox"             # default: ""
    binding: SANDBOX                                 # required; Worker binding name (Service binding or DO-stub Fetcher)
    sandbox_tool_name: ""                            # default: "" → falls back to `name`
    timeout_ms: 30000                                # default: null (no per-call cap)
    path_prefix: ""                                  # default: ""; optional sub-path before /exec
    args_schema: null                                # default: null; optional JSON Schema advertised verbatim
    fatal: false                                     # default: false
```

Each entry becomes a `Tool` whose executor is a `SandboxExecutor` (`transport: sandbox`). Unlike `containers`, the binding is a worker-local `Fetcher` (Service binding or DO-stub adapter wrapping `@cloudflare/sandbox`) — no external HTTPS gateway, no SSRF guard, no auth-broker header. Audit rows carry `transport: sandbox`.

Fetcher contract:

```
POST {prefix}/exec
{ "tool": "<sandbox-side tool name>",
  "arguments": { ...args },
  "session": "<threadId>",
  "timeout_ms": <int>? }

200 { "content": "...", "exit_code"?: number, "stderr"?: string }
non-2xx       → [sandbox error] tool: status …  (mapped via codeForStatus: 429 → rate_limited, etc.)
exit_code N≠0 → [sandbox exit N] tool: stderr/content  (provider_error)
```

Felix passes the request's `threadId` as `session` so a multi-turn conversation reuses the same sandbox DO and filesystem state persists across turns. See [`examples/sandbox-worker/`](../../examples/sandbox-worker/) for the reference adapter.

Sandboxes are **forbidden** when `pattern ∈ {router, parallel, groupchat}`, same as containers / queues.

## spec.browser_tools

```yaml
browser_tools:
  - name: fetch_page                                 # required; tool name the model sees
    description: "Fetch a web page"                  # default: ""
    binding: BROWSER                                 # required; Worker binding name (Fetcher wrapping @cloudflare/puppeteer)
    op: content                                      # default: content; one of content|links|snapshot|screenshot|pdf|json
    timeout_ms: 30000                                # default: null
    path_prefix: ""                                  # default: ""
    args_schema: null                                # default: null
    fatal: false                                     # default: false
```

Each entry becomes a `Tool` whose executor is a `BrowserExecutor` (`transport: browser`). Binding is a worker-local `Fetcher` wrapping `@cloudflare/puppeteer` or the Browser Rendering REST API. Audit rows carry `transport: browser`. The tool `source` is tagged `browser:{op}` so audit can slice by op directly.

Built-in ops:

| op | response body | when to use |
|---|---|---|
| `content`    | HTML of the rendered DOM (`text/html`) | Default. Model reads the page as HTML. |
| `links`      | JSON `string[]` of deduped absolute hrefs | Crawl planning, link extraction. |
| `snapshot`   | JSON `{ html, screenshot_base64 }` | "Look at this page" — visual + DOM in one round trip. |
| `screenshot` | `data:image/png;base64,...` text | Pair with a vision-capable model (Anthropic, OpenAI). |
| `pdf`        | `data:application/pdf;base64,...` text | Print-friendly snapshot. |
| `json`       | response body verbatim (passthrough) | Skip Chromium for endpoints that already return JSON. |

See [`examples/browser-worker/`](../../examples/browser-worker/) for the reference adapter.

Browser tools are **forbidden** when `pattern ∈ {router, parallel, groupchat}`, same as containers / queues / sandboxes.

## spec.sub_agents and spec.aggregator_prompt

```yaml
sub_agents: []                 # default
aggregator_prompt: ""          # default: ""; only allowed when pattern: parallel
```

- `sub_agents` is **required** when `pattern ∈ {router, parallel, groupchat}` and **forbidden** otherwise.
- `aggregator_prompt` is only allowed for `pattern: parallel`; it overrides the system prompt for the synthesis step. If empty, the system prompt is used as the aggregator prompt.

Sub-agents are resolved by name through the same `loadManifest` path. Cycles will recurse — author at your own risk.

## spec.max_turns

```yaml
max_turns: 4                   # default: 4; max: 20
```

Used by `groupchat` for the number of turns and by `parallel` indirectly (each child runs once). Clamped to `ABSOLUTE_LIMITS.max_turns = 20`.

## spec.memory

```yaml
memory:
  checkpointer: do             # default; aliases: agentcore, sqlite; "none" disables
  store: vectorize             # default; aliases: agentcore; legacy: memory; "none" disables
```

- `checkpointer` controls the per-thread session event log backing (`ConversationDO`).
- `store` controls long-term semantic memory in Vectorize.
- When `store` resolves to `vectorize`, the builder auto-injects `memory_remember` and `memory_recall` tools.

## spec.session

```yaml
session:
  strategy: full_replay         # default; alternatives: windowed:N, summarizing:N, semantic:N
```

Picks the `SessionStrategy` that turns the session event log into the working-set messages the model sees on each turn. Distinct from `memory.checkpointer`, which gates whether events are persisted at all.

- `full_replay` (default) — every prior message is replayed. Behavior-preserving with the legacy checkpointer.
- `windowed:N` — keep the last N events; drop the rest.
- `summarizing:N` — keep the last N raw events, call the model to summarize everything older into a synthetic system message. The summary is cached as a `kind: 'audit'` event on the session log with `metadata: { type: 'session_summary', covers_to_seq: N }`, so steady-state rendering only re-summarizes when new events cross the keep boundary. Degrades to windowed if no model is available or the summarizer call throws — never fails the request.
- `semantic:N` — keep the top-N most-relevant past events by cosine similarity between the incoming user message and each candidate event (BGE embeddings via `env.AI`). Falls back to a windowed-N tail when `env.AI` is absent so dev loops without an AI binding don't crash.

**Anchor messages.** Any `SessionEvent` with `metadata.pinned: true` survives every strategy's compaction. In `windowed:N` the pinned events render alongside the last-N window (so total render length grows beyond N by the pin count). In `summarizing:N` pinned events bypass the summarizer entirely. In `semantic:N` pinned events are always included in the rendered output regardless of similarity score. Tools mark events as pinned by setting `metadata.pinned = true` on their `tool_result` event.

Invalid strategy specs fall back to `full_replay`.

## spec.execution

```yaml
execution:
  mode: transient               # default; alternative: durable
  resume_token_ttl_seconds: null
```

- `transient` (default) — runs the agent loop in the request isolate. A worker eviction mid-run loses the in-flight branch.
- `durable` — wraps every invocation in a Cloudflare Workflow instance (`AGENT_WORKFLOW` binding). The instance survives evictions, retries on transient errors with exponential backoff, and pairs with A2A `tasks/resubscribe` for client-side resume. Valid on any single-agent pattern (`react`, `deep`, `reflect`, `plan_execute`); multi-agent patterns must opt their children's leaf manifests in instead. Requires `memory.checkpointer != none` — durable workflows without a session log cannot resume mid-conversation. Binding-graceful: falls back to in-isolate invocation with a warning when `AGENT_WORKFLOW` is absent.

`resume_token_ttl_seconds` is an advisory hint for clients about how long the Workflow instance id stays valid for `tasks/resubscribe`. Null defers to the Workflows runtime default.

## spec.tools_retrieval

```yaml
tools_retrieval:
  enabled: false                # default: false
  top_k: 20                     # default: 20
  model: "@cf/baai/bge-base-en-v1.5"  # default; Workers-AI embedding model
```

Just-in-time tool retrieval. When enabled, the react/deep loop filters the tool list each turn to the top-K most relevant tools by cosine similarity between BGE-embedded tool descriptions and the recent conversation. Tool embeddings are cached per-isolate by name + FNV-1a hash of description so repeated turns within the same manifest version amortize the cost.

The dispatch map still holds every tool, so a hallucinated tool name on a filtered turn routes through the standard unknown-tool audit path. Below `top_k` total tools the helper is a no-op. Falls back to the full tool list when `env.AI` is absent.

## spec.artifacts

```yaml
artifacts:
  enabled: false                # default: false
  threshold_chars: 8000         # default: 8000; spill tool results above this length
  preview_chars: 200            # default: 200; first N chars kept inline in the stub
  default_window_chars: 4000    # default: 4000; default fetch_artifact window
  max_window_chars: 16000       # default: 16000; hard cap on fetch_artifact window
```

Reference-based artifacts. When enabled, tool results exceeding `threshold_chars` are spilled to R2 under `artifacts/<tenant_id>/<thread_id>/<tool_call_id>.txt`. The model sees a `[artifact:REF] preview… [truncated, N chars total]` stub instead of the full content. The builder auto-injects a `fetch_artifact(ref, start?, length?)` tool that reads back windowed content with continuation hints when more remains.

Refs are tenant + thread scoped at the R2 key level; cross-tenant reads return `[artifact not found]` rather than leaking existence. Spill failures fall back to the original content rather than dropping data.

## spec.reflect

```yaml
reflect:
  verifier_model: ""            # default: ""; empty → falls back to primary model id
  threshold: 0.7                # default: 0.7
  max_iterations: 2             # default: 2; max: 5
  criteria: ""                  # default: ""; free-form pass criteria
```

Consumed by `pattern: reflect`. Wraps the react loop with a verifier model that scores each final response. Below `threshold`, the critique is appended as a synthetic user turn and react replays up to `max_iterations`. Each iteration emits a `judge_score` audit event with `source: 'reflect'`.

`verifier_model` is the logical model id used by the verifier. You usually want it cheaper than the primary — `claude-haiku-4` against a Sonnet primary, or `llama-3-fast` against either. Verifier output is parsed as JSON (`{score, critique}`). A thrown verifier (broken binding, network) is treated as pass to avoid infinite loops; the original response stands.

No-op for other patterns. `max_iterations: 1` short-circuits to the inner react agent with no verifier overhead.

## spec.plan_execute

```yaml
plan_execute:
  planner_model: ""               # default: ""; empty → falls back to primary model id
  executor_model: ""              # default: ""; empty → falls back to primary model id
  max_subtasks: 8                 # default: 8; ceiling 20
  replan_on_failure: true         # default: true
  max_replans: 2                  # default: 2; 0 disables replanning
  executor_recursion_limit: 6     # default: 6; per-subtask react cap
  planner_few_shots: 3            # default: 3; 0 disables few-shots
```

Consumed by `pattern: plan_execute`. The planner emits a JSON plan, the executor runs each subtask in a bounded react sub-loop with the manifest's tools, and a synthesis pass produces the final assistant turn. Each step emits a `plan_step` audit row with `payload.source: 'plan_execute'`.

`planner_model` and `executor_model` are logical ids resolved through `MODEL_ROUTES`. The common shape is a flagship planner (Sonnet 4.7 / Opus 4) with a cheaper executor (Haiku / Llama 3 70B fast) — planning quality compounds across subtasks; executor cost dominates the run. Both empty means the primary model handles both roles.

`max_subtasks` caps each plan; plans longer than this are truncated by `parsePlannerReply`. The planner is told the cap so it adapts. Raise for multi-day style tasks; past 20 you usually want sub-agents (`pattern: parallel` / `groupchat`).

`replan_on_failure` controls whether the planner is re-called when a subtask fails. With `false`, the first failure aborts the plan, but synthesis still produces a user-facing turn over partial outcomes — better to surface what got done than drop the whole turn.

`executor_recursion_limit` is the per-subtask react cap. Intentionally separate from the manifest's top-level `recursion_limit` so one rogue subtask cannot exhaust the whole budget.

`planner_few_shots` (when `spec.procedural_memory.enabled`) prepends up to N past successful plans for this manifest, drawn from the same Vectorize index `recall_procedure` uses. 0 disables few-shots even when procedural memory is on.

Cross-field validation: `plan_execute` requires at least one tool / peer / container — the planner's whole purpose is to drive tools. Bare-chat plan_execute is rejected.

No-op for other patterns.

## spec.procedural_memory

```yaml
procedural_memory:
  enabled: false                # default: false
  top_k: 3                      # default: 3; how many past procedures recall_procedure returns
  embedding_model: "@cf/baai/bge-base-en-v1.5"  # default
```

After a successful run, distills `(user_intent, tool_call_sequence)` into a Vectorize vector and upserts under the `MEMORY_VEC` binding with `metadata.kind: 'procedural'`. The builder auto-injects a `recall_procedure(query)` tool the model can call BEFORE planning multi-step approaches to see what worked previously. Returns up to `top_k` past similar successes as few-shot examples.

Filter by `tenant_id` + `kind` so cross-tenant retrievals fail safe.

## spec.auth

```yaml
auth:
  inbound:
    schemes: []                # default; informational, surfaced in agent card
    required_scopes: []        # default; AND-checked against principal.scopes
    allow_anonymous: false     # default; routes 401 anonymous callers when false
  outbound:
    providers: []              # default; OAuth provider names this agent will call
```

`enforceManifestAuth` (`src/auth/middleware.ts:108-122`) gates each request: anonymous callers get 401 unless `allow_anonymous: true`; missing required scopes get 403.

## spec.a2a

```yaml
a2a:
  publish: false               # default; controls whether this manifest is offered for A2A peering
  capabilities: []             # default; entries: { id, description, input_schema_ref }
```

`publish: true` flips the bit; capability entries are surfaced verbatim in the agent card.

## spec.observability

```yaml
observability:
  trace: true                  # default
  metrics: []                  # default; free-form list of metric names to emit
```

`trace: true` opens a `manifestSpan` per build. Metric emission is opt-in.

## spec.policies

```yaml
policies:
  - id: write-paths             # required
    description: ""             # default: ""
    required_scopes: ["data:write"]  # AND-checked against principal.scopes
    tools: ["update_record"]    # which tools this policy gates
```

Tools listed in multiple policies must satisfy **all** policies (AND logic). Federation bundle policies merge with these and win on id collision. See [internals/governance.md](../internals/governance.md).

## spec.limits

```yaml
limits:
  max_tool_calls: null          # default: null (no cap); ceiling: 200
  max_wall_clock_seconds: null  # default: null; ceiling: 600
  max_peer_hops: null           # default: null; ceiling: 5
  max_input_tokens: null        # default: null; ceiling: 1_000_000
  max_output_tokens: null       # default: null; ceiling: 100_000
  precount: false               # default: false; pre-flight token counting (Anthropic only)
```

Per-run caps. `null` means "no manifest-level cap" (the absolute ceiling still applies). When `max_peer_hops` is set, every `peer_*` tool invocation counts against it.

`max_input_tokens` / `max_output_tokens` are checked **before each model call** by the react / router / parallel patterns. Token usage accumulates on the request-scoped `LimitState.tokens`, so a multi-step run that crosses its budget mid-loop short-circuits to a deny message rather than spending more. Sub-agents share the same `LimitState`, so a parallel fan-out's children contribute to the parent's budget. OpenAI's `cached_tokens` are subtracted from `prompt_tokens` so cache hits don't double-count against `max_input_tokens`.

`precount: true` adds a free `/v1/messages/count_tokens` round-trip before each model call; if the projected input would push cumulative spend past `max_input_tokens`, the call is denied before any paid request is made. Only effective on Anthropic routes (the count endpoint is Anthropic-specific) and only meaningful when `max_input_tokens` is set.

When the wall-clock cap fires, the per-request `AbortController` is aborted — tools that pass `ctx.signal` through to `fetch(url, { signal })` cancel mid-flight instead of just being blocked from starting. This applies to peer (A2A) and MCP tools by default; custom tool authors should propagate the signal to their own outbound calls.

Absolute ceilings ([src/limits/models.ts](../../src/limits/models.ts)):

| Limit | Ceiling |
|---|---|
| `max_tool_calls` | 200 |
| `max_wall_clock_seconds` | 600 |
| `max_peer_hops` | 5 |
| `max_input_tokens` | 1,000,000 |
| `max_output_tokens` | 100,000 |
| `recursion_limit` | 50 |
| `max_turns` | 20 |

> **Note**: `recursion_limit` bounds **model turns**. One model response that emits 5 tool calls counts as one step. Use `max_tool_calls` for the per-call budget across the entire run.

## spec.guardrails

```yaml
guardrails:
  providers: []                # default: []; available: "pii"
  block_on_match: false        # default: false; true = deny, false = redact
  targets: [input, output]     # default: [input, output]; subset of ["input", "output"]
  judges: []                   # default: []; declared JudgeRule entries
```

`pii` runs four regex patterns (email, SSN, US phone, credit card) with SHA-256 fingerprints written to audit (never the raw value). `pii` is currently the only accepted provider — `bedrock` is explicitly rejected at parse time with a validation error until an AI Gateway content-policy hook lands. Omitting `targets` scans **both** input and output (the default is `[input, output]`, not `[]`). See [internals/governance.md](../internals/governance.md).

**Judges** (`spec.guardrails.judges[]`) declare inferential sensors that score each tool result via `env.AI` (Workers AI, no AI Gateway tokens) and deny calls below threshold:

```yaml
guardrails:
  judges:
    - name: relevance                                # required; surfaced in audit
      criteria: "tool result is on-topic for the user's question"  # required; verifier prompt
      threshold: 0.7                                  # default: 0.7
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"  # default
      target_tools: []                                # default: []; empty = all tools
```

The `llm_judge` wrapper composes *after* the regex-style guardrails: a tool result that escapes the `pii` filter can still be denied for being off-topic or hallucinated. Each rule emits a `judge_score` audit event per call. Skipped on outputs already flagged by `denyOutput` (other wrappers) or `toolErrorOutput` (transport error) — judging a deny string is wasted compute. Short-circuits to pass when `env.AI` is absent so a misconfigured Worker doesn't silently block every tool call.

## spec.approvals

```yaml
approvals:
  - id: production-writes      # required
    description: ""            # default: ""
    tools: ["update_record"]   # which tools require human approval before invocation
```

When a tool listed under an approval rule is called, the wrapper synthesizes a deterministic call signature, persists an `approval_request` row, and returns a deny string to the model. The approver decides through `POST /approvals/:id/decide`; the next retry with the same arguments goes through. ApprovalsDO serializes concurrent decisions.

## spec.recursion_limit

```yaml
recursion_limit: null          # default: null (uses pattern default of 10); ceiling: 50
```

Used by react and deep to bound the tool-call loop iterations.

## spec.anomaly

```yaml
anomaly:
  enabled: true                 # default: true — anomaly detection is ON unless muted
  min_volume: 10                # default: 10; min tool-call volume in the window before a spike can flag
  min_rate: 0.2                 # default: 0.2; min recent error rate (0-1) to flag
  baseline_factor: 3            # default: 3; recent rate must exceed factor × 24h baseline
```

Per-manifest tuning for the anomaly-detection cron (`runAnomalyScan`). Unlike most feature blocks this **defaults to enabled** — set `enabled: false` to mute the detector for a noisy manifest. When an anomaly fires on a canary variant, the detector emits `anomaly_detected` and auto-rolls the canary back (`canary_weight = 0`). Detection windows stay global; only the thresholds are per-manifest. Defaults live in `DEFAULT_ANOMALY_CONFIG` (`src/manifests/schema.ts`).

## Cross-field rules

Enforced in `src/manifests/validate.ts`:

| Rule | Constraint |
|---|---|
| `apiVersion` must equal `orchestrator/v1` | otherwise 400 at validate |
| `kind` must equal `Agent` | otherwise 400 at validate |
| `pattern ∈ {router, parallel, groupchat}` | requires `sub_agents` non-empty; forbids `peers`, `containers`, `queues`, `sandboxes`, `browser_tools` |
| Single-agent patterns | forbid non-empty `sub_agents` |
| `aggregator_prompt` non-empty | only allowed when `pattern: parallel` |
| `pattern: plan_execute` | requires at least one of `tools`, `peers`, `containers` |
| `execution.mode: durable` | forbidden on multi-agent patterns; requires `memory.checkpointer != 'none'` |
| `tools` | every name must be registered with the ToolProvider (if a registry is supplied to the validator) |
| `skills` | every name must be bundled (if a known set is supplied) |

## Examples

### Minimal anonymous chat agent

```yaml
apiVersion: orchestrator/v1
kind: Agent
metadata:
  name: quick
spec:
  pattern: react
  model:
    id: claude-sonnet-4
  system_prompt:
    inline: |
      You are a friendly assistant. Use the calculator tool for arithmetic.
  tools: [calculator]
  auth:
    inbound:
      allow_anonymous: true
```

### Hardened deep-research agent with governance

```yaml
apiVersion: orchestrator/v1
kind: Agent
metadata:
  name: research
  version: 2.1.0
  description: Deep research agent with HITL approvals on write paths.
spec:
  pattern: deep
  model:
    id: claude-opus-4
    temperature: 0
    max_tokens: 4096
  system_prompt:
    inline: |
      You are an internal research analyst. Draft a plan with plan_create
      before invoking any tool. Update steps as you go.
  tools: [calculator]
  skills:
    - name: web-search
  mcp_servers:
    - name: notion
      url: https://mcp.notion.example.com
      transport: sse
  peers:
    - name: billing
      url: https://billing.felix.run
  memory:
    checkpointer: do
    store: vectorize
  auth:
    inbound:
      allow_anonymous: false
      required_scopes: ["research:read"]
    outbound:
      providers: ["notion"]
  recursion_limit: 20
  policies:
    - id: write-paths
      required_scopes: ["research:write"]
      tools: [notion__create_page]
  limits:
    max_tool_calls: 40
    max_wall_clock_seconds: 120
    max_peer_hops: 2
  guardrails:
    providers: [pii]
    block_on_match: false
    targets: [input, output]
  approvals:
    - id: external-publication
      description: Any write to Notion requires reviewer signoff.
      tools: [notion__create_page, notion__update_page]
  observability:
    trace: true
    metrics: [research_runs_total]
```
