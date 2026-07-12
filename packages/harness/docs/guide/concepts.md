---
description: "The mental model behind Felix — manifests, tenants, threads, patterns, tools, memory, and auth."
---

# Concepts

The mental model behind Felix. Read this before writing a manifest or integrating a client.

Felix is a **managed agents harness** in the shape Anthropic describes in [Managed Agents](https://www.anthropic.com/engineering/managed-agents): the runtime owns plumbing (auth, audit, limits, persistence, HTTP surface) and the agent itself is composed from three decoupled abstractions — **Session**, **Pattern / Provider registries**, and **ToolExecutor**. Each can be swapped without touching the others. Most of this page is about what the harness exposes to manifest authors; the deep cuts live in the [architecture internals](../internals/architecture.md).

## Manifest

A YAML or JSON document with `apiVersion: orchestrator/v1` and `kind: Agent`. The schema is defined in `src/manifests/schema.ts` and uses Zod `.strict()`, so unknown keys are rejected outright. A manifest declares everything an agent needs: pattern, model, system prompt, tools, skills, MCP servers, A2A peers, memory backend, auth requirements, policies, limits, guardrails, approvals.

:::tip
See [manifest-reference.md](manifest-reference.md) for every field with defaults and examples, and [management-api.md](management-api.md) for the `/manifests` REST surface used to deploy manifests at runtime.
:::

Manifests can be loaded from four sources. The request-path resolver `resolveManifest(env, tenantId, name)` (`src/manifests/resolver.ts`) walks them in order and returns the first hit:

1. **Tenant Postgres active version** — the `manifests` table + `manifest_active` pointer (`apps/api/migrations/0001_baseline.sql`). Tenants populate this through the `/manifests` REST surface; rows are append-only and rollback flips the pointer. (The resolver's internal `source` value stays `tenant_d1` — see [management-api.md](management-api.md).)
2. **Tenant R2 override** — `manifests/<tenant_id>/<name>.json` in the `BUNDLES` bucket. Useful for bulk pre-population via `wrangler r2 object put`; the management API does not write here.
3. **Global R2 override** — `manifests/<name>.json` in `BUNDLES`. Affects every tenant.
4. **Bundled** — `pnpm build:manifests` reads the repo-local `manifests/*.yaml`, validates each with the Zod schema, and emits `src/manifests/bundled.ts`.

:::caution[Use `resolveManifest` in request handlers]
The sync `loadManifest(name)` (`src/manifests/loader.ts:22-33`) is kept for system-only call sites that have no tenant context — cron, A2A discovery, MCP default. Request handlers (`/chat`, `/v1/chat/completions`, `/a2a` `tasks/send`) MUST use `resolveManifest` so per-tenant overrides take effect.
:::

The bundled set is also exposed as OpenAI "models" through `GET /v1/models`.

## Tenant

Multi-tenancy is structural in Felix, not advisory. Every Postgres row uses a composite primary key `(tenant_id, id)`; every `memory_vectors` row is filtered by tenant on `recall`. The tenant id comes from the verified inbound JWT:

1. Custom claim `custom:tenant_id`, if present.
2. Custom claim `tenant_id`.
3. First label of the JWT issuer host (e.g. `acme.cloudflareaccess.com` → `acme`).
4. Anonymous traffic always gets `default`.

See `payloadToPrincipal` in `src/auth/jwt.ts` for the exact resolution.

The Cloudflare Rate Limiting binding (`TENANT_RATE_LIMIT`) is keyed by this tenant id with a sliding window of 100 requests per 60 seconds. Anonymous traffic shares the `default` bucket. `/health`, `/docs`, `/openapi.json`, and `/.well-known/*` are exempt.

## Thread and Session

Conversation persistence is per-thread. A thread id is always `${tenantId}:${suffix}` where the suffix is caller-supplied. The server rejects suffixes containing `:` or `#` so the tenant prefix cannot be smuggled away from the authenticated principal:

- `POST /chat` and `POST /chat/stream` — `thread_id` in the JSON body
- `POST /v1/chat/completions` — `x-thread-id` header; **without it each request is stateless**, so `/v1` remains a clean OpenAI-compatible surface by default
- `POST /a2a` (`tasks/send`, `tasks/sendSubscribe`) — the A2A task id becomes the thread suffix, so a continuation task replays the same conversation

:::note[Thread suffix validation]
Suffixes containing `:` or `#` are rejected with HTTP 400 so the authenticated tenant prefix cannot be smuggled away. The server always produces the full id as `${tenantId}:${suffix}`.
:::

A `Session` is the harness's external context object for a thread. The session log is append-only, with each `SessionEvent` carrying `seq`, `kind`, the message-shaped payload, and optional `metadata`. Felix exposes the log via `ConversationDO` (one Durable Object per thread id; `blockConcurrencyWhile` serializes appends so parallel sub-agents writing to the same thread can't race). A pluggable `SessionStrategy` decides what the model sees on each turn — see the Memory section below.

## Agent

The compiled output of `buildAgent(manifest, deps)`. An `Agent` has two methods:

- `invoke(input): Promise<InvokeOutput>` — run synchronously, return the full message stream
- `streamEvents(input): AsyncIterable<Event>` — stream events as they're produced

Where `input = { messages, threadId? }`.

Agents are cached per manifest name inside each router (one cached `Promise<Agent>` per `body.model` or `body.manifest`). The cache is keyed only by name — the `compose(env)` ToolProvider is shared, so the cache survives across requests in the same isolate.

## Pattern

Patterns are the agent's loop shape. Felix's pattern registry is open: built-ins self-register at module load and new patterns can be added by `registerPattern(name, build, { kind })` (see [internals/manifest-pipeline.md](../internals/manifest-pipeline.md)). The seven built-ins declared via `spec.pattern`:

- **react** (default) — sequential tool-calling loop bounded by `recursion_limit`
- **deep** — react plus auto-injected planning tools (`plan_create`, `plan_update_step`, `plan_get`) and a planning suffix on the system prompt
- **router** — a classifier model picks one sub-agent by name; the `threadId` is forwarded so the conversation continues across routing decisions
- **parallel** — fan-out all sub-agents concurrently, then synthesize via an aggregator model; the `threadId` is stripped before fan-out so children cannot race-write the parent's session
- **groupchat** — round-robin sub-agent turns with a shared transcript and a fixed `max_turns`
- **reflect** — wraps a react base with a verifier model that scores each final response against `spec.reflect.criteria`; below threshold the critique is appended as a synthetic user turn and react replays up to `spec.reflect.max_iterations`. `judge_score` audit event per iteration
- **plan_execute** — planner/executor split. A planner model emits a JSON plan; an executor model runs each subtask in a bounded react sub-loop with the manifest's tools; a synthesis pass produces the final assistant turn. Audits as `plan_step` rows. Pairs with `spec.procedural_memory.enabled` for "what plans worked before" few-shots. Pick when the task is genuinely multi-step and a single react loop conflates phases

The three multi-agent patterns (router, parallel, groupchat) declare `kind: 'multi-agent'` in their registry entry; the validator (`src/manifests/validate.ts`) queries `isMultiAgentPattern(name)` and enforces that multi-agent patterns require `sub_agents` and forbid `peers`, `containers`, `queues`, `sandboxes`, `browser_tools`. Registering a new multi-agent pattern picks up the same constraints automatically.

## Skill

A `SKILL.md` file with YAML frontmatter and a Markdown body. Bundled like manifests via `pnpm build:manifests`. The frontmatter declares tools, MCP servers, and A2A peers to fold into any manifest that lists the skill; the body is appended to the system prompt under a `## Active Skills` header.

Skill activation is **per-tenant** and **restriction-only**: a tenant overlay can disable skills the manifest declares, but cannot enable skills the manifest didn't. The overlay is stored as a JSON array on `(tenant_id, manifest_id)` in the `skill_activation` table. `null` means "no overlay — all declared skills active"; `[]` means "all disabled"; `[a, b]` means "intersection with declared". Three tools (`list_skills`, `activate_skill`, `deactivate_skill`) let agents manage their own overlay; see `apps/api/src/composition.ts`.

## Tool

Anything the model can call. A `Tool` has a `name`, `description`, Zod `args` schema, and an `executor: ToolExecutor` that owns the transport. The model loop dispatches by name (`tool.executor.execute(args, ctx)`); the harness routes to whichever transport the tool was built with. Today's transports:

| Transport | Built by | Where it runs |
|---|---|---|
| `local`     | `defineTool({ ..., handler })` — worker-resident handler | inside the Worker |
| `mcp`       | `McpExecutor` (constructed by `bindExternalMcp` in `src/mcp/client.ts`) | the remote MCP server |
| `a2a`       | `A2AExecutor` (constructed by `makePeerTool` in `src/a2a/client.ts`) | a remote Felix peer via JSON-RPC `tasks/send` |
| `container` | `ContainerExecutor` / `containerTool({ ... })` in `src/tools/container-executor.ts` | a sandbox or container gateway reachable by HTTPS |
| `queue`     | `QueueExecutor` / `queueTool({ ... })` in `src/tools/queue-executor.ts` | a separate consumer Worker reading from a Cloudflare Queue; the result lands back on the session asynchronously |
| `sandbox`   | `SandboxExecutor` / `sandboxTool({ ... })` in `src/tools/sandbox-executor.ts` | a worker-local Fetcher (Service binding wrapping `@cloudflare/sandbox`, or a DO-stub adapter) — no external HTTPS gateway |
| `browser`   | `BrowserExecutor` / `browserTool({ ... })` in `src/tools/browser-executor.ts` | a worker-local Fetcher wrapping `@cloudflare/puppeteer` or the Browser Rendering REST API |

**`ToolErrorCode` taxonomy.** Every failure across the 7 transports surfaces as one of a stable code set: `invalid_arguments` / `transport_unavailable` / `provider_error` / `timeout` / `user_aborted` / `rate_limited` / `permission_denied` / `internal`. The code lands on `audit_events.payload.error_code` and the `tool_result` text the model sees (`[<source> error/<code>] …`), so anomaly detection can group by `(manifest, tool, error_code)` and the model can branch deterministically.

The `queue` transport is the async case: `execute()` enqueues the job and returns a stub. The model continues this turn assuming the result will arrive later. A separate consumer writes a `tool_result` event back to the session log keyed to the dispatching `tool_call_id`; when the client reconnects via `tasks/resubscribe`, `session.wake()` reports the cycle resolved and the next model step renders the result. See [internals/persistence.md#async-tool-resumption-queue-transport](../internals/persistence.md#async-tool-resumption-queue-transport).

Tools come from these sources (orthogonal to transport):

1. **Built-ins** — registered in `compose(env)` (`apps/api/src/composition.ts`). The core set is `calculator`, `list_skills`, `activate_skill`, `deactivate_skill`, plus the commerce suite: catalog/cart/order tools, `commerce_checkout`, `commerce_record_consent`, personalization (`recommend_products`, `identify_customer`), visual search (`search_by_image`), and the B2B quote-to-cash tools — see [the commerce docs](../../../commerce/docs/index.md#tool-catalog) for the full list.
2. **Skills** — frontmatter `tools:` lists folded in at build time.
3. **External MCP servers** — namespaced as `${server.name}__${tool.name}`, fetched from each `mcp_servers[].url`.
4. **A2A peers** — every `peers[]` entry becomes a `peer_${name}` tool. The `peer_` prefix is the contract that increments `peerHops` in the limits wrapper.
5. **Containers** — every `containers[]` entry becomes a tool whose executor is a `ContainerExecutor` pointing at the declared gateway. Used for sandboxed code execution and untrusted side-effects; see [manifest-reference.md#speccontainers](manifest-reference.md#speccontainers) for the gateway contract.
6. **Queues** — every `queues[]` entry becomes a tool whose executor is a `QueueExecutor` bound to a Cloudflare Queue. Used for long-running async work that resolves across requests via `tasks/resubscribe`. See [manifest-reference.md#specqueues](manifest-reference.md#specqueues).
7. **Sandboxes** — every `sandboxes[]` entry becomes a tool whose executor is a `SandboxExecutor` targeting a worker-local Fetcher. See [manifest-reference.md#specsandboxes](manifest-reference.md#specsandboxes) and [`examples/sandbox-worker/`](../../examples/sandbox-worker/).
8. **Browser tools** — every `browser_tools[]` entry becomes a tool whose executor is a `BrowserExecutor` targeting a worker-local Fetcher wrapping `@cloudflare/puppeteer`. See [manifest-reference.md#specbrowser_tools](manifest-reference.md#specbrowser_tools) and [`examples/browser-worker/`](../../examples/browser-worker/).
9. **`fetch_artifact`** — auto-injected by the builder when `spec.artifacts.enabled: true` so the model can read back oversized tool results that were spilled to R2.
10. **`recall_procedure`** — auto-injected when `spec.procedural_memory.enabled: true` so the model can recall past similar tool-call sequences from pgvector.

Every tool is wrapped by the governance pipeline before being exposed to the model — see [internals/governance.md](../internals/governance.md). Wrappers replace `tool.executor` while preserving the inner `transport` label so audit and observability report the true transport even after composition.

:::tip[JIT tool retrieval]
`spec.tools_retrieval.enabled: true` filters the tool list down to the top-K most relevant tools per turn by cosine similarity between BGE-embedded tool descriptions and the recent conversation. Essential at 30+ tool catalogs — without it the full list inflates every model call's prompt. Falls back to the full list when `env.AI` is absent.
:::

**Reference-based artifacts** (`spec.artifacts.enabled: true`) spill tool results above `threshold_chars` to R2 and replace them with a `[artifact:REF]` stub the model can fetch piecewise via `fetch_artifact`. Cuts context spent on sandbox stdout dumps, scraped HTML, and large JSON arrays.

## Memory

Four orthogonal layers:

- **Session checkpointer** (`spec.memory.checkpointer`) — the per-thread session event log. Backed by `ConversationDO`. Enum values: `do` (default), `agentcore` and `sqlite` (legacy aliases), `none`. The `Session` interface (`src/session/types.ts`) is what patterns consume.
- **Session strategy** (`spec.session.strategy`) — decides how prior events render into the working-set messages the model sees. `full_replay` (default) replays every prior message; `windowed:N` keeps the last N events; `summarizing:N` keeps the last N raw and model-summarizes everything older, caching the summary as a `kind: 'audit'` event so steady-state rendering skips the model call; `semantic:N` keeps the top-N most relevant past events by BGE cosine similarity to the current user message. Events tagged `metadata.pinned: true` survive every strategy's compaction.
- **Long-term store** (`spec.memory.store`) — semantic memory across threads. Backed by the `memory_vectors` pgvector table with 768-dimensional `@cf/baai/bge-base-en-v1.5` embeddings. Enum values: `vectorize` (default; legacy name, now pgvector-backed), `agentcore` (legacy alias), `memory` (legacy in-process), `none`.
- **Procedural memory** (`spec.procedural_memory.enabled: true`) — after a successful run, distills `(user_intent, tool_call_sequence)` into a `memory_vectors` row tagged `kind: 'procedural'`. The auto-injected `recall_procedure(query)` tool returns past similar successes so the model can see "last time this came up, the sequence that worked was X → Y → Z." Filter-scoped by tenant.

When `memory.store` resolves to `vectorize`, the builder auto-injects `memory_remember` and `memory_recall` tools. The agent never needs to declare these in `tools:`.

All memory queries are tenant-scoped: `recall` filters on `{ tenant }` and `forget` verifies ownership before deleting.

## Durable execution

`spec.execution.mode: durable` wraps every invocation in an `AgentWorkflow` instance (Cloudflare Workflows, `AGENT_WORKFLOW` binding). The Workflow re-resolves the manifest with `execution.mode` forced to `transient` to break recursion, rebuilds the agent, and runs `agent.invoke()` inside `step.do(...)` with conservative retry policy (3 attempts, exponential backoff, 15-minute timeout). A worker eviction mid-run replays the step rather than losing the branch. The instance id is returned to the caller; A2A `tasks/resubscribe` then resumes from the live Workflow's status.

Valid on any single-agent pattern (`react`, `deep`, `reflect`, `plan_execute`). Multi-agent patterns must opt their children's leaf manifests in instead. Requires `memory.checkpointer != 'none'`. Binding-graceful: falls back to in-isolate invocation with a warning when `AGENT_WORKFLOW` is absent (dev probes, unit tests).

:::note
The `orchestrator_durable_fallback` counter fires whenever durable mode degrades to in-isolate execution. It **should be zero in production** — a non-zero value means `AGENT_WORKFLOW` is not bound in the current environment.
:::

## Canary rollouts

`manifest_active` has three columns beyond the stable `version`: `canary_version`, `canary_weight` (0-100), and the stable pointer itself. The resolver hashes `(tenant_id, thread_id, manifest_name, stable_v, canary_v)` via SHA-256 to deterministically bucket each thread into stable or canary — flipping either version re-randomises bucket assignment, so progressive ramps don't carry old buckets forward. A single thread stays on one variant across the rollout.

- `POST /manifests/:name/canary` sets `{canary_version, canary_weight}`. Emits `manifest_canary_set` audit.
- `POST /manifests/:name/rollback` zeroes `canary_weight` (optionally also clears the version pointer). Emits `manifest_canary_cleared`.
- The anomaly detector cron auto-rolls-back any canaried manifest that trips an error-rate threshold. Emits both `auto_rollback` and `manifest_canary_cleared` audit events.
- The chat / OpenAI-compat routes set `x-manifest-variant: stable|canary` on the response so an operator can verify a canary is reaching real traffic.

## Eval harness

The eval surface is three Postgres tables (`eval_datasets`, `eval_dataset_items`, `eval_runs`) backing `/eval/datasets`, `/eval/datasets/{name}/items`, `/eval/datasets/{name}/run`, and `/eval/runs`. A run executes off the request path: `POST …/run` returns `202 { run_id }` and the scoring happens in a background job (`execCtx.waitUntil`) so a large dataset can't blow the Worker CPU / subrequest ceiling — poll `GET /eval/runs/{id}` for the terminal `completed` / `failed` status. Each item carries:

- `user_input` — the prompt to drive through the candidate manifest
- `rubric` — pass criteria. Layered scoring:
  1. **Trajectory gate** — `max_tool_calls`, `forbidden_tools`, `required_tool_sequence` (subsequence). Runs first, free, catches "right answer via wasteful path" regressions.
  2. **Substring gates** — `must_include` / `must_not_include` (case-insensitive). Cheap deterministic backstop.
  3. **LLM judge** — `criteria` free-form, scored 0..1 by a Workers-AI model. `panelJudge` composer aggregates N judges by median / mean / min.

Cost dimensions per item — `tokens_input`, `tokens_output`, `tool_call_count`, `duration_ms` — are recorded on each `ItemScore` so the CI gate can fail on "won by brute force" regressions (matched pass rate but 3× the token spend).

`pnpm eval` is the CI gate (`scripts/eval.ts`):

```bash
pnpm eval -- --base-url https://staging-make.felix.run \
  --dataset golden --candidate research \
  --baseline evals/baseline.json --cost-tolerance 1.5 \
  --include-adversarial --adversarial-floor 0.95
```

`--include-adversarial` runs a companion `<dataset>_adversarial` dataset seeded from `src/eval/seeds/adversarial.ts` (8 curated items across 5 categories: prompt_injection, jailbreak, tool_misuse, pii_probe, data_exfil). The candidate must pass a higher floor (default 0.95) than the happy-path dataset — safety regressions block rollout even when quality holds.

## Auth

Inbound: JWT bearer tokens verified against the verifiers configured in `JWT_VERIFIERS` env (Cloudflare Access and Cognito are the two built-in schemes). Anonymous traffic populates a context with `tenantId = 'default'`. A per-manifest `auth.inbound.allow_anonymous` flag decides whether each manifest accepts anonymous calls; `auth.inbound.required_scopes` lets a manifest demand specific OAuth scopes.

Outbound: client-credentials OAuth tokens cached in the `oauth_token_cache` Postgres table, encrypted at rest with `OAUTH_CACHE_KEY` (AES-256-GCM). Manifests declare which providers they need under `auth.outbound.providers`.

## Federation

A central authority can ship a signed `PolicyBundle` to R2 at the key configured by `POLICY_BUNDLE_KEY`. Every Felix isolate refreshes its in-process bundle cache from `FederationDO` every 10 minutes via the worker cron (`*/10 * * * *`). The bundle's policies and approvals are merged with each manifest's during `buildAgent` — bundle policies win on `id` collision so a central revocation cannot be silently disabled.

Bundles are signed Ed25519 and the public key lives in `POLICY_BUNDLE_PUBKEY`. In staging and production an unsigned or tampered bundle is rejected; in development it logs a warning and keeps loading so local iteration isn't blocked.

:::caution
In staging and production, an unsigned or tampered `PolicyBundle` is **rejected** — the previous active bundle is kept. Never test federation bundle changes on production directly; verify on staging first.
:::

## Where the request goes

```
inbound request
  → authMiddleware (verify JWT, build AuthContext, install RequestContext via AsyncLocalStorage)
  → rateLimitMiddleware (sliding window keyed by tenantId)
  → route handler (enforceManifestAuth + buildAgent or management lookup)
  → agent.invoke() or agent.streamEvents()
    → react/deep loop OR multi-agent dispatcher
      → model call (AI Gateway: Anthropic / OpenAI / Workers AI)
      → tool.executor.execute (transport: local / mcp / a2a / container / queue / sandbox / browser, wrapped by Approvals → Judge → Guardrails → Limits → Policies)
        → audit events queued to AUDIT_QUEUE
      → Session.appendBatch (fire-and-forget via execCtx.waitUntil)
```

The full trace is documented in [internals/architecture.md](../internals/architecture.md).
