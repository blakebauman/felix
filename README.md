# Felix Orchestrator

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-docs.felix.run-orange)](https://docs.felix.run)
[![Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)

A **managed agents harness** on Cloudflare Workers, shaped after Anthropic's [Managed Agents](https://www.anthropic.com/engineering/managed-agents) architecture: Session, Pattern/Provider registries, and ToolExecutor are decoupled abstractions that can be swapped without touching the others. TypeScript on Hono, with Durable Objects, D1, R2, KV, Vectorize, Queues, and AI Gateway.

An `apiVersion: orchestrator/v1` manifest compiles into a runnable agent exposing `/v1/*` (OpenAI-compatible), `/chat`, `/a2a`, `/mcp`, `/jobs`, `/plans`, `/audit`, `/approvals`, `/manifests`, `/eval`, and `/.well-known/agent-card.json`. Manifests can be bundled at build time, dropped into R2, or managed per-tenant through the `/manifests` REST surface (append-only versions with active-pointer rollback; reads/writes gated by `manifests:read` / `manifests:write` scopes). Two Felix deployments can act as A2A peers and share a federation `PolicyBundle` via R2.

On top of the harness sits **Felix Commerce**, an agentic-commerce layer: conversational catalog → cart → approval-gated Stripe checkout as ordinary agent tools, an [Agentic Commerce Protocol](https://developers.openai.com/commerce) merchant endpoint (`/acp`), per-brand D2C storefronts with an embeddable widget (`/shop`, `/widget`, `/brands`), schema.org / AI-discoverability surfaces (`/structured`, `/geo`), B2B quote-to-cash (`/b2b`), a pluggable entity data-source seam (`/entities`), and consent + attribution. See [Agentic commerce](#agentic-commerce) below.

> Full OpenAPI 3.1 spec at `/openapi.json` · interactive Scalar reference at `/docs`. The core routes are documented with Zod-derived schemas, examples, and the bearer security scheme; the commerce routers are documented in [packages/commerce/docs/index.md](packages/commerce/docs/index.md).

## Three seams

| Seam | What it is | Where to find it |
|---|---|---|
| **Session** | Append-only event log per thread (`seq`, `kind`, message payload, optional metadata — including `pinned: true` anchor messages). The harness asks a `SessionStrategy` (`full_replay` / `windowed:N` / `summarizing:N` / `semantic:N`) to render the working-set messages instead of mutating an in-memory history. | `packages/harness/src/session/` |
| **Pattern / model registries** | `react`, `deep`, `router`, `parallel`, `groupchat`, `reflect`, `plan_execute` and the Anthropic / OpenAI / Workers AI providers self-register at module load; `getPattern(name)` and `getModelProvider(name)` resolve them at build time. New loops / providers register with one line in `composition.ts` or a sibling module. | `packages/harness/src/patterns/registry.ts`, `packages/harness/src/patterns/model-registry.ts` |
| **ToolExecutor** | Every `Tool` carries a `transport`-labelled executor (`local` / `mcp` / `a2a` / `container` / `queue` / `sandbox` / `browser`). The model loop dispatches by name; the harness routes to whichever transport the tool was built with. Failures use a stable `ToolErrorCode` taxonomy (`invalid_arguments`, `provider_error`, `timeout`, `rate_limited`, …). Governance wrappers preserve the inner transport label. | `packages/harness/src/tools/executor.ts`, `packages/harness/src/tools/{container,sandbox,browser,queue}-executor.ts`, `packages/harness/src/mcp/client.ts`, `packages/harness/src/a2a/client.ts` |

Full documentation lives in [`packages/harness/docs/`](packages/harness/docs/README.md) — user guide under [`packages/harness/docs/guide/`](packages/harness/docs/guide/), contributor reference under [`packages/harness/docs/internals/`](packages/harness/docs/internals/).

## Layout

```
packages/harness/src/
  manifests/    schema (Zod) · loader (bundled JSON) · validate · builder · resolver (4-layer chain + canary hash routing)
  tools/        ToolProvider · ToolExecutor seam (local / container / sandbox / browser / queue) · errors taxonomy · artifacts · retrieval (JIT tool filter)
  patterns/     react · deep · router · parallel · groupchat · reflect · plan_execute + AI Gateway model client (fallbacks + confidence escalation) + pattern/model registries
  session/      Session + SessionStrategy (full_replay / windowed / summarizing / semantic) · DO-backed store · anchor messages
  policy/       declarative scope policies · federated PolicyBundle (R2)
  limits/       per-run caps via AsyncLocalStorage
  guardrails/   PII regex pipeline + llm_judge wrapper (Workers AI) + AI Gateway hook
  approvals/    HITL store (D1) + ApprovalsDO critical section
  audit/        append-only event log (D1, batched via AUDIT_QUEUE) + /audit/metrics aggregator
  eval/         golden datasets · pluggable Judge (workersAI / panel / deterministic) · trajectory rubrics · adversarial seeds · runner
  plans/        plan_create/plan_get/plan_update_step (D1)
  skills/       SKILL.md loader + per-tenant activation overlay (D1)
  a2a/          JSON-RPC tasks/send|get|sendSubscribe|cancel + agent card + A2AExecutor (transport: a2a) + A2ATaskDO
  mcp/          MCP server + remote MCP client (McpExecutor — transport: mcp)
  memory/       ConversationDO (session event log) + Vectorize-backed semantic store + procedural memory (recall_procedure tool)
  workflows/    AgentWorkflow entrypoint (Cloudflare Workflows-backed durable execution)
  auth/         JWT verifiers (Cloudflare Access + Cognito + self-issued JWKS) + requireScope + outbound OAuth registry + Hono middleware
  jobs/         Workers Cron Triggers + persistent registry + anomaly-detector + continuous-eval + abandoned-cart scan + GEO monitor
  observability/ counters (Analytics Engine) + spans (OTel-shaped)
  security/     SSRF allow-list, rate limit, AES-256-GCM at-rest helpers, constant-time compare, expr eval, redaction
  api/          OpenAPI spec + Scalar docs UI + /eval + /geo + consent/attribution surfaces
  composition.ts  wires Felix tools into a ToolProvider; deployment-time seat for registerPattern / registerModelProvider extensions
  app.ts          Hono app factory
  index.ts        Worker entry + DO exports + scheduled handler (cron: federation refresh + jobs + queue orphan sweep + anomaly scan + abandoned-cart scan + continuous eval + GEO monitor)
packages/commerce/src/
  (Felix Commerce plugin, @felix/commerce)
  catalog/cart/orders · Stripe checkout + webhook · ACP merchant endpoint · brands/storefront/widget · structured-data (schema.org) · B2B quote-to-cash + billing seam · personalization · visual search · dynamic pricing · consent
  entities/     entity data-source seam (native / federated / synced; http + mcp connectors, webhook push)
  geo/          GEO/AEO brand-visibility models + store (answer-engine monitoring)
apps/api/migrations/
  0001_init.sql       D1 schema (audit, plans, jobs, approvals, skill_activation, oauth_token_cache)
  0002_harden.sql     jobs PK → (tenant_id, name); idx_jobs_next_run partial index
  0003_manifests.sql  manifests + manifest_active (append-only tenant manifest store)
  0004_eval.sql       eval_datasets + eval_dataset_items + eval_runs (golden dataset storage)
  0005_manifest_canary.sql  canary_version + canary_weight columns on manifest_active
  0006–0018           commerce layer: products/orders (0006), ACP sessions (0007), brands (0008-0009),
                      data_sources (0010), B2B accounts/quotes/pricing/billing (0011-0014), GEO (0015),
                      consent + attribution (0016), personalization (0017), dynamic pricing (0018)
packages/harness/scripts/
  bundle-manifests.ts   YAML → JSON build step (reads packages/harness/manifests/*.yaml + packages/harness/skills/*/SKILL.md)
apps/api/scripts/
  eval.ts               CI gate — runs an eval dataset, compares pass_rate / mean_tokens to a baseline file, exits non-zero on regression
  mint-jwt.ts           self-issued JWT minter for the scoped management APIs
  deploy.md             deploy runbook
apps/
  chat-ui/          React + Vite chat UI; proxy Worker streaming /chat/stream over a service binding
  docs/             Starlight docs site (docs.felix.run), aggregates packages/*/docs
examples/
  queue-consumer/   reference consumer for the queue transport
  python-sandbox/   container-transport demo (mock gateway + manifest)
  sandbox-worker/   adapter Worker bridging the sandbox transport to @cloudflare/sandbox
  browser-worker/   adapter Worker bridging the browser transport to @cloudflare/puppeteer
```

## Topology

| Concern | Implementation |
|---|---|
| HTTP | Hono on Workers |
| LLM | AI Gateway → Anthropic / OpenAI / Workers AI (logical id resolved via `MODEL_ROUTES` env var) with ordered fallback chain on `provider_error` and optional confidence-routed escalation on low-confidence responses |
| Agent runtime | Manual tool-loop (react) + dedicated DOs for multi-agent patterns. `spec.execution.mode: durable` wraps every invocation in a Cloudflare Workflow (`AGENT_WORKFLOW`) so worker eviction mid-run replays cleanly. |
| Per-request limit state | `AsyncLocalStorage<RequestContext>` populated by Hono auth middleware |
| Audit / Plans / Jobs / Approvals / Eval | D1 with composite (tenant_id, id) keys + tenant-scoped ORDER BY |
| Approvals critical section | `ApprovalsDO` serializes concurrent `decide` writes |
| A2A task state | `A2ATaskDO` (one DO per `tenant#task` id) |
| Session event log | `ConversationDO` (one DO per thread id); `/events` slice + cursor API |
| Federation `PolicyBundle` | R2 + `FederationDO` (cron-refreshed singleton) |
| Canary rollouts | `manifest_active.{canary_version, canary_weight}` + deterministic hash routing in the resolver. Anomaly detector cron auto-rolls-back on flagged manifests; `x-manifest-variant: stable|canary` response header on chat / OpenAI surfaces |
| Inbound JWT | `jose` + JWKS cache. Verifiers: Cloudflare Access, Cognito. |
| Outbound OAuth | D1-cached client-credentials tokens, AES-256-GCM-encrypted at rest via `OAUTH_CACHE_KEY` |
| Background jobs | Workers Cron Triggers (`*/10 * * * *`) → federation refresh + `runScheduledJobs` + queue-orphan sweep + anomaly detector + abandoned-cart scan + continuous-eval (canary online benchmarking) + GEO monitor |
| Commerce | Stripe (hosted Checkout + Shared Payment Tokens, signature-verified webhooks, idempotent completion) · D1 catalog/orders · session-log cart · approval-gated checkout · ACP merchant endpoint keyed by `ACP_API_KEY` |
| Observability | Analytics Engine sink for counters (`METRICS` binding); structured-log spans with duration + attributes; `judge_score`, `anomaly_detected`, `auto_rollback`, `manifest_canary_*`, `model_switch`, `eval_run` audit event types in addition to the pre-existing `tool_call` / `policy_decision` / etc. |
| Eval harness | D1-backed golden datasets, deterministic + Workers-AI + panel judges, trajectory rubrics scoring the tool-call sequence, adversarial seed dataset, `pnpm eval` CI gate (pass_rate + cost-tolerance + adversarial floor) |
| Durable execution | `spec.execution.mode: durable` → `AgentWorkflow` (Cloudflare Workflows). Survives worker eviction mid-run; retries on transient errors; pairs with A2A `tasks/resubscribe` |

## Bootstrapping

```bash
pnpm install
cp apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc   # wrangler.jsonc is gitignored; fill in your ids

cd apps/api                                       # bare wrangler commands run from the API app
pnpm wrangler d1 create orchestrator           # paste the id into wrangler.jsonc
pnpm wrangler kv namespace create CACHE        # paste the id into wrangler.jsonc
pnpm wrangler r2 bucket create felix-orchestrator-bundles
pnpm wrangler vectorize create felix-memory --dimensions=768 --metric=cosine  # matches @cf/baai/bge-base-en-v1.5
pnpm wrangler queues create felix-audit
cd ../..

pnpm build:manifests                           # produces packages/harness/src/manifests/bundled.ts + packages/harness/src/skills/bundled.ts
pnpm migrate:local
cp apps/api/.dev.vars.example apps/api/.dev.vars && $EDITOR apps/api/.dev.vars   # local secrets for `wrangler dev`
pnpm dev                                       # root scripts delegate to @felix/harness
```

For deployed envs, set secrets via `pnpm exec wrangler secret put <NAME> --env staging|production` (run from `apps/api/`, where `wrangler.jsonc` lives). The worker reads:
- `ANTHROPIC_API_KEY` — required for any `provider: anthropic` route
- `OPENAI_API_KEY` — required for any `provider: openai` route
- `CF_AIG_TOKEN` — Authenticated Gateway bearer; required when the AI Gateway slug enables Authenticated Gateway
- `OAUTH_CACHE_KEY` — base64 32-byte AES-256 key for encrypting `oauth_token_cache.access_token`; required in staging/production
- `POLICY_BUNDLE_PUBKEY` — base64 Ed25519 raw public key for verifying the federation `PolicyBundle` signature; required in staging/production

`AI_GATEWAY_SLUG` and `AI_GATEWAY_ACCOUNT_ID` are vars in `apps/api/wrangler.jsonc`, one per env.

### Open-source / hybrid model routing

Anthropic/OpenAI keys are **optional** — both providers are read lazily at call time, so an agent that only routes to `provider: workers-ai` needs neither (and skips the AI Gateway entirely; Workers AI uses the native `env.AI` binding, so no `CF_AIG_TOKEN`/`AI_GATEWAY_*` either). Embeddings (BGE), the eval/guardrail judges, and procedural/semantic memory already run on Workers AI regardless of the chat model.

Three bundled manifests demonstrate the spectrum (`packages/harness/manifests/oss-only.yaml`, `oss-fast.yaml`, `hybrid-router.yaml`):
- **Fully OSS** — `oss-only` runs react on `llama-3-pro` (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, one of the tool-capable Workers AI models). Set `DEFAULT_MODEL_ID` to an OSS route and leave the proprietary keys unset to run key-free.
- **Hybrid** — `hybrid-router` puts intent classification on `claude-haiku-4` and dispatches to OSS Llama sub-agents (`oss-only` / `oss-fast`), so the strong model only pays for the short routing turn. The same shape applies to `plan_execute.planner_model`, `reflect.verifier_model`, and `spec.model.confidence_escalation.escalate_to` (OSS primary → flagship only on low-confidence turns).

The OSS + Claude routes used here already ship in `DEFAULT_MODEL_ROUTES` (`packages/harness/src/env.ts`) — no `MODEL_ROUTES` override needed. Tool-using OSS agents must pick a model in `WORKERS_AI_TOOL_CAPABLE` (`packages/harness/src/patterns/model.ts`); going OSS forgoes Anthropic-only extras (free preflight token counting, prompt caching, native extended thinking), which degrade to no-ops/fallbacks.

## Agentic commerce

The commerce layer is a vertical built entirely from the harness seams — no new abstractions:

- **Conversational shopping** — `catalog_*` / `cart_*` / `order_status` tools over a D1 catalog; the cart is a pinned event in the session log, not a table. `commerce_checkout` creates a hosted Stripe Checkout Session and is **approval-gated** through the standard HITL pipeline, so a human confirms before any money moves. The Stripe webhook writes the order, decrements inventory, and stamps attribution.
- **ACP merchant endpoint** (`/acp`) — product feed + checkout sessions for external buyer agents (Agentic Commerce Protocol). Server-side pricing only; settles Stripe Shared Payment Tokens with idempotent completion; authenticated by a constant-time `ACP_API_KEY` bearer, not JWT.
- **D2C storefronts** — `POST /brands` provisions a per-brand agent manifest under the brand's own tenant; `/shop` serves it anonymously (path- or Host-resolved), and `/widget/loader.js` embeds a self-contained chat widget on any site.
- **Discoverability (GEO/AEO)** — schema.org JSON-LD feeds, per-product `@graph`, sitemap/robots, and `/.well-known/ai-catalog.json` for answer engines; the `/geo` surface + cron replays tracked shopping queries through a generative engine and records whether the brand shows up (rank, competitors).
- **B2B quote-to-cash** (`/b2b`) — accounts/buyers with roles and spending limits, purchase-authority checks that route over-limit buys into approvals, contract + dynamic pricing, quotes → orders → invoices via a pluggable billing seam (internal or Stripe invoicing). Multi-agent procurement manifests ship bundled.
- **Entity seam** (`/entities`) — B2B/commerce entities resolve through `native` (D1) / `federated` (live http/mcp connector) / `synced` (pull or webhook push) data sources, so a tenant can back accounts or quotes with an external ERP.
- **Personalization + search** — behavior-event stream, `recommend_products` (Vectorize similarity), `identify_customer` (cross-session identity), visual search (caption-then-embed), abandoned-cart detection cron with a webhook recovery seam.
- **Consent + attribution** — append-only consent log captured in-conversation (`commerce_record_consent`, optional hard gate on checkout) and per-order channel attribution (`chat` / `acp` / `b2b` / `widget`) queryable at `/commerce/attribution/summary`.

Full detail: [packages/commerce/docs/index.md](packages/commerce/docs/index.md). Bundled manifests: `orderloop`, `shopping`, `procurement*`. Stripe secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) and `ACP_API_KEY` are optional — without them the commerce surfaces degrade to 503/not-configured and the rest of the harness is unaffected.

## Test

```bash
pnpm test                # vitest — two projects: `unit` (node) and `workers` (@cloudflare/vitest-pool-workers / miniflare)
pnpm typecheck           # tsc --noEmit
pnpm lint                # biome
```

## Status

Implemented:

- AI Gateway streaming wired for both Anthropic and OpenAI; Workers AI
  streaming uses the native SSE shape and buffers reads across chunk
  boundaries so split frames don't drop deltas.
- Anthropic prompt caching (`spec.model.cache: true`) tags the system
  prompt, last tool definition, and last conversation message with
  `cache_control: ephemeral` (skipped on thinking blocks). Extended
  thinking (`thinking_budget` 1024–64000) with `redacted_thinking`
  round-tripping on tool-use continuations.
- Ordered model fallback chain (`spec.model.fallbacks: string[]`) — on
  `provider_error` (5xx, 408, 429, network), the wrapper cascades to
  the next fallback and emits a `model_switch` audit event with
  `reason: 'provider_error'`. Refuses to retry on 4xx (auth /
  validation) or AbortError.
- Confidence-routed escalation (`spec.model.confidence_escalation`) —
  short or marker-laden ("I am not sure", "I don't know") responses
  re-call against `escalate_to` and emit `model_switch` with
  `reason: 'low_confidence'`.
- Cloudflare AI Gateway Authenticated Gateway: `CF_AIG_TOKEN` is sent as
  `cf-aig-authorization: Bearer …` on every gateway call when set.
- Pre-flight token-counting budget runs before each Anthropic call via
  the free `/v1/messages/count_tokens` endpoint and short-circuits if
  the projected spend would breach `max_input_tokens`.
- `streamChat` returns the final `ModelChatResult` as the generator
  return value (captured via `await stream.next()` once `done===true`),
  eliminating the prior second non-stream `chat()` round-trip.
- Vectorize-backed semantic memory in `memory/store.ts`; the builder
  auto-injects `memory_remember` / `memory_recall` tools when a manifest
  declares `memory.store: vectorize` (or the legacy `agentcore` alias).
- Procedural memory (`spec.procedural_memory.enabled: true`) — successful
  runs are distilled into `(intent → tool_call_sequence)` Vectorize
  rows; the auto-injected `recall_procedure` tool returns past similar
  successes as few-shot examples for tool ordering.
- Just-in-time tool retrieval (`spec.tools_retrieval.enabled: true`) —
  per-turn cosine-similarity filter over BGE-embedded tool descriptions
  so 100-tool catalogs only send the top-K relevant schemas to the model.
- Reference-based artifacts (`spec.artifacts.enabled: true`) — tool
  results above `threshold_chars` get spilled to R2 and replaced with a
  `[artifact:REF]` stub; the auto-injected `fetch_artifact` tool reads
  back windows. Cuts context spent on sandbox stdout dumps / scraped
  HTML / large JSON arrays.
- Workers AI tool-calling for tool-capable models
  (Hermes 2 Pro Mistral, Llama 3.1 instruct, Mistral Small 3.1).
- Real cron schedule parsing in `jobs/cron.ts` (5-field, supports
  `*`, ranges, lists, and `*/N` / `0-30/5` step expressions).
- `AUDIT_QUEUE` producer in `audit/store.ts` + batched consumer in
  `index.ts:queue` that flushes up to 50 events per pull via `DB.batch()`,
  with per-row fallback if the batch fails so one poison row doesn't
  starve the queue.
- `/approvals/:id/decide` routes through `ApprovalsDO` so concurrent
  decisions on the same approval id are serialized.
- Federation `PolicyBundle` is Ed25519-signed and verified against
  `POLICY_BUNDLE_PUBKEY` on every refresh; `oauth_token_cache.access_token`
  is AES-256-GCM encrypted at rest via `OAUTH_CACHE_KEY`.
- Remote MCP `inputSchema` forwarded to the LLM through the
  `Tool.rawInputSchema` escape hatch (preserves provider-supplied
  validation without round-tripping through Zod).
- ToolError taxonomy — every failure across the 7 transports maps to a
  stable `ToolErrorCode` (`invalid_arguments` / `transport_unavailable`
  / `provider_error` / `timeout` / `user_aborted` / `rate_limited` /
  `permission_denied` / `internal`). Lands on `audit_events.payload.error_code`
  for slice-and-dice via `GET /audit/metrics`.
- Sixth governance wrapper — `llm_judge` runs declared
  `spec.guardrails.judges[]` on tool results via `env.AI` (native, no
  AI Gateway tokens); below-threshold denies with
  `denyOutput(..., 'guardrails')` and emits a `judge_score` audit row.
- Anomaly detector cron — flags tool-call error-rate spikes per
  `(tenant, manifest, tool)`; auto-rolls-back the canary on a flagged
  manifest that has one.
- Eval harness — D1-backed datasets, deterministic + Workers-AI + panel
  judges, trajectory rubrics (`max_tool_calls`, `forbidden_tools`,
  `required_tool_sequence`) gating *before* the LLM judge, cost-aware
  per-item scoring, adversarial seed dataset, `pnpm eval` CI gate
  comparing pass_rate + mean_tokens to a baseline file.
- Durable execution — `spec.execution.mode: durable` wraps every
  invocation in an `AgentWorkflow` so a worker eviction mid-run replays
  the step. Binding-graceful: falls back to in-isolate when
  `AGENT_WORKFLOW` is absent.
- Canary rollouts — extended `manifest_active` schema with
  `(canary_version, canary_weight)`; the resolver hashes
  `(tenant_id, thread_id, manifest_name, stable_v, canary_v)` for
  deterministic per-thread bucketing. New
  `POST /manifests/:name/canary` + `/rollback` endpoints; auto-rollback
  hooks into the anomaly detector.
- Reflection pattern — `pattern: reflect` wraps any react base with a
  verifier model that scores each final response; below-threshold
  appends critique and replays up to `max_iterations`.
- Sandbox + Browser tool transports — `transport: 'sandbox'` (worker-
  local Fetcher to a `@cloudflare/sandbox` adapter) and
  `transport: 'browser'` (worker-local Fetcher to a `@cloudflare/puppeteer`
  adapter). Reference adapters in `examples/sandbox-worker/` and
  `examples/browser-worker/`.

- Continuous-eval cron — samples recent production inputs and replays
  them through each in-flight canary, judging the result
  (`payload.source: 'continuous'`).
- Agentic commerce layer — see
  [packages/commerce/docs/index.md](packages/commerce/docs/index.md).

Open follow-ups:

- Real OTel exporter binding via `@microlabs/otel-cf-workers`.
- Pipelines → R2 → Parquet warehouse for off-D1 audit retention.

### Session persistence

`ConversationDO` is the session event log; `Session` / `SessionStrategy`
(`packages/harness/src/session/`) are the abstraction the patterns consume. When an
`InvokeInput.threadId` is set and the manifest's `memory.checkpointer` is
`do` (default), `agentcore`, or `sqlite`, the loop:

  1. Opens a `Session` for the thread and calls
     `strategy.render(session, incoming, { systemPrompt, model })` —
     `full_replay` (default) replays every event; `windowed:N` keeps
     the last N; `summarizing:N` model-summarizes everything older and
     caches the summary as a `kind: 'audit'` event so subsequent
     renders skip the model call until new events cross the keep
     boundary.
  2. Appends new caller / assistant / tool events incrementally as
     `SessionEvent`s, batched per step via `execCtx.waitUntil` so DO
     round-trips don't block the LLM step. `DoSession.appendBatch`
     retries 3× with exponential backoff on 5xx / network errors;
     terminal failures emit a `checkpoint_failure` audit event and
     bump the `orchestrator_checkpoint_failures` counter rather than
     being swallowed by `console.warn`.
  3. Preserves the full message shape (tool_calls, tool_call_id, name,
     plus any `thinking` / `redacted_thinking` blocks) so a
     continuation can rehydrate paused tool-use cycles faithfully.

Route plumbing:
- `POST /chat`           — caller-supplied `thread_id` in the body.
- `POST /chat/stream`    — same.
- `POST /v1/chat/completions` — `x-thread-id` header opts in to a stable
  thread; absent, each request gets a fresh `tenant:openai-<uuid>` so
  `/v1` stays stateless by default (no hidden conversation state on the
  OpenAI-shaped surface).
- `POST /a2a tasks/send` / `tasks/sendSubscribe` — the A2A task id becomes
  the thread id (`tenant:a2a-<taskId>`), so a `continuation` block on a
  parent task resumes the same conversation.

Multi-agent semantics:
- **router** forwards `threadId` to the single chosen child.
- **parallel** strips `threadId` before fanning out so concurrent children
  don't race-write the same DO.
- **groupchat** owns its own transcript and doesn't forward `threadId`.
