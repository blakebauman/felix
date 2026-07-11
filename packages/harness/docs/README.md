# Felix Documentation

Felix is a **managed agents harness** on Cloudflare Workers, shaped after Anthropic's [Managed Agents](https://www.anthropic.com/engineering/managed-agents) architecture: Session, Pattern/Provider registries, and ToolExecutor are decoupled abstractions, each swappable without touching the others. A YAML or JSON document with `apiVersion: orchestrator/v1` is compiled into a runnable agent and exposed over four protocols:

- **OpenAI-compatible** chat completions at `/v1/chat/completions` (sync + SSE)
- **A2A JSON-RPC** at `/a2a` (agent-to-agent peering)
- **MCP HTTP JSON-RPC** at `/mcp` (Model Context Protocol)
- **Direct REST/SSE** at `/chat` (Felix-native)

Management surfaces (`/audit`, `/plans`, `/jobs`, `/approvals`, `/manifests`, `/eval`) cover observability, plan and job state, human-in-the-loop approvals, per-tenant manifest management (with canary + rollback), and the eval harness. Every management route is gated by a per-surface scope (`audit:read`, `manifests:write`, …) — see [guide/management-api.md](guide/management-api.md).

The **Felix Commerce layer** adds buyer- and merchant-side surfaces on the same harness: conversational shopping tools, an Agentic Commerce Protocol endpoint (`/acp`), D2C brand storefronts (`/shop`, `/widget`, `/brands`), schema.org / answer-engine discoverability (`/structured`, `/geo`), B2B quote-to-cash (`/b2b`), an entity data-source seam (`/entities`), and consent + attribution. See [the commerce docs](../../commerce/docs/index.md).

Every D1 row is keyed by `(tenant_id, id)` and every thread id is server-prefixed by the authenticated tenant, so transcripts can never cross tenants.

## Three seams

- **Session** is the harness's external context object. Events are append-only with monotonic `seq`, a `kind` discriminator, and the message-shaped payload. A pluggable `SessionStrategy` (`full_replay` / `windowed:N` / `summarizing:N` / `semantic:N`) renders the working-set messages for each model call instead of mutating an in-memory history. See [internals/persistence.md](internals/persistence.md) and [internals/patterns.md](internals/patterns.md).
- **Pattern / model registries** are open. Built-in patterns (`react`, `deep`, `router`, `parallel`, `groupchat`, `reflect`, `plan_execute`) and providers (`anthropic`, `openai`, `workers-ai`) self-register at module load. Adding a new loop or provider is one `registerPattern(...)` / `registerModelProvider(...)` call — no edits to `builder.ts` or `model.ts`. See [internals/manifest-pipeline.md](internals/manifest-pipeline.md) and [internals/model-client.md](internals/model-client.md).
- **ToolExecutor** decouples the model loop's `execute(name, input) → string` view from the transport that actually does the work. `local` runs in-worker; `mcp` proxies to a remote MCP server; `a2a` delegates to a peer; `container` dispatches to a container gateway; `queue` enqueues a job and resumes via `wake()` + `tasks/resubscribe`; `sandbox` fronts the Cloudflare Sandbox SDK; `browser` fronts Browser Rendering via `@cloudflare/puppeteer`. Governance wrappers (policies / limits / guardrails / judges / approvals) wrap the executor while preserving its transport label.

## Live reference

A running deployment exposes:

- `GET /openapi.json` — OpenAPI 3.1.0 specification covering the core routes (OpenAI surface, `/chat`, `/a2a`, `/mcp`, and the `/audit` · `/approvals` · `/plans` · `/jobs` · `/manifests` · `/eval` management surfaces), grouped by tag; internal back-channel routes are excluded, and the commerce routers are documented in [the commerce docs](../../commerce/docs/index.md) rather than the spec. A completion-gate test keeps the covered surfaces exhaustive.
- `GET /docs` — Scalar API reference UI rendered from the spec above
- The prose docs (this directory plus `packages/commerce/docs/`) are published as a separate static site at [docs.felix.run](https://docs.felix.run) — built by the `apps/docs` Starlight app (`pnpm docs:build` / `docs:deploy`). The Worker's legacy `/docs/home`, `/docs/guide/*`, `/docs/internals/*` routes 301 there, so old "Read more" links keep resolving.
- `GET /health` — liveness plus active federation `PolicyBundle` metadata
- `GET /.well-known/agent-card.json` — A2A discovery document

## Audience routing

| You want to... | Read |
|---|---|
| Stand up a local instance and make a first request | [guide/getting-started.md](guide/getting-started.md) |
| Understand manifests, tenants, threads, patterns | [guide/concepts.md](guide/concepts.md) |
| Write a manifest | [guide/manifest-reference.md](guide/manifest-reference.md) |
| Call the runtime from a client | [guide/rest-api.md](guide/rest-api.md) |
| Run audit, plans, jobs, approvals, manifests, evals | [guide/management-api.md](guide/management-api.md) |
| Deploy to staging or production | [guide/deploy.md](guide/deploy.md) |
| Find where a request goes after `fetch` | [internals/architecture.md](internals/architecture.md) |
| Understand how a manifest becomes an agent | [internals/manifest-pipeline.md](internals/manifest-pipeline.md) |
| Read the loop semantics of each pattern | [internals/patterns.md](internals/patterns.md) |
| Trace AI Gateway routing for Anthropic, OpenAI, Workers AI | [internals/model-client.md](internals/model-client.md) |
| Understand D1 / KV / R2 / Vectorize / Queues / DOs | [internals/persistence.md](internals/persistence.md) |
| Build on the commerce layer (shopping, ACP, storefronts, B2B, GEO) | [the commerce docs](../../commerce/docs/index.md) |
| Understand policies, limits, guardrails, approvals | [internals/governance.md](internals/governance.md) |
| Understand inbound JWT and outbound OAuth | [internals/auth.md](internals/auth.md) |
| Find counter labels, audit payload shapes, alert thresholds | [internals/observability.md](internals/observability.md) |
| Add or run tests | [internals/testing.md](internals/testing.md) |

## Tree

```
docs/
  README.md                  this file
  guide/
    getting-started.md       prerequisites, install, first request
    concepts.md              manifests, tenants, threads, patterns, skills, tools
    manifest-reference.md    every Zod field with defaults and examples
    rest-api.md              /chat /v1 /a2a /mcp with curl + JSON
    management-api.md        /audit /plans /jobs /approvals /manifests /eval
    deploy.md                bindings, secrets, MODEL_ROUTES, custom domains
  internals/
    architecture.md          entry points, middleware chain, DO topology
    manifest-pipeline.md     the buildAgent compile step
    patterns.md              react / deep / router / parallel / groupchat / reflect / plan_execute
    model-client.md          AI Gateway: Anthropic + OpenAI + Workers AI
    persistence.md           D1 schema + KV + R2 + Vectorize + Queues + DOs
    governance.md            policy / limits / guardrails / approvals + federation
    auth.md                  JWT verifiers + outbound OAuth + RequestContext
    observability.md         counter labels, audit payload shapes, alert thresholds
    testing.md               Vitest unit and workers projects
```

The commerce layer's docs live with their package at `packages/commerce/docs/` and appear as the Commerce section of the docs site.
