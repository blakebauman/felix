---
description: "Deploy Felix to staging and production on Cloudflare Workers — bindings, secrets, MODEL_ROUTES, JWT verifiers, and cron triggers."
---

# Deploy

Felix ships to two Cloudflare Workers environments out of the box (staging and production) and runs locally via Wrangler. Every environment has isolated D1, KV, R2, Vectorize, and Queue resources — the two never share state.

## Bindings

From `apps/api/wrangler.jsonc` — your gitignored copy of the tracked template (`cp apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc`, then fill in the `REPLACE_*` account/resource ids). Bare `wrangler` commands in this guide run from `apps/api/`. The dev/local set is the top-level block; `env.staging` and `env.production` override D1 / KV / R2 / Vectorize / Queue with isolated resources.

| Binding | Type | Purpose |
|---|---|---|
| `AI` | Workers AI | Native Llama / Mistral inference. External providers (Anthropic, OpenAI) go through AI Gateway via `fetch` instead. |
| `HYPERDRIVE` | Hyperdrive | Neon Postgres (relational store, replacing `DB` during the pg cutover). Create per env with `wrangler hyperdrive create <name> --connection-string='<Neon DIRECT url, no -pooler>' --caching-disabled` — caching must stay off (Felix depends on read-after-write), and Hyperdrive replaces Neon's pooler. Stores connect via `getDb(env)`; local dev routes through `localConnectionString` (Docker Postgres, `pnpm db:up`), and schema is applied with `pnpm migrate:pg:*` (node-pg-migrate over the direct connection — never through Hyperdrive). |
| `DB` | D1 | **Deprecated — being replaced by `HYPERDRIVE`; removed after the pg cutover.** Harness core: `audit_events`, `plans`, `jobs`, `approvals`, `skill_activation`, `oauth_token_cache`, `manifests` + `manifest_active`, `eval_datasets` + `eval_dataset_items` + `eval_runs`. Commerce (migrations 0006–0018): `products`/`orders`/`order_items`, `acp_checkout_sessions`, `brands`/`brand_domains`, `data_sources`, B2B `accounts`/`buyers`/`quotes`/`invoices`/`contract_prices`/`billing_settings`, `geo_queries`/`geo_observations`, `consents`/`order_attribution`, personalization + dynamic-pricing tables. |
| `CACHE` | KV | JWKS cache, outbound OAuth token cache, manifest cache. |
| `BUNDLES` | R2 | Signed `PolicyBundle`, per-tenant manifest overrides at `manifests/<tenant_id>/<name>.json`, global overrides at `manifests/<name>.json`, and artifact spills at `artifacts/<tenant_id>/<thread_id>/<tool_call_id>.json` (when `spec.artifacts.enabled`). |
| `MEMORY_VEC` | Vectorize | 768-dim BGE index (`@cf/baai/bge-base-en-v1.5`) — semantic memory, JIT tool retrieval, `semantic:N` session strategy, procedural memory. |
| `AUDIT_QUEUE` | Queue (producer) | Audit events fan out from the producer in `audit/store.ts`. |
| `felix-audit` consumer | Queue (consumer) | Batched persist into Postgres — one multi-row INSERT per pull (`max_batch_size: 50`, `max_batch_timeout: 5s`). |
| `METRICS` | Analytics Engine | `orchestrator_*` counters + histograms via `recordCounter` / `recordHistogram`. Falls back to structured `console.log` when absent. |
| `AGENT_WORKFLOW` | Workflows | Durable agent execution (`AgentWorkflow`) for manifests with `execution.mode: durable`. Optional — falls back to in-isolate execution when absent. |
| `CONVERSATION_DO` | Durable Object | One per thread id; session event log backing the `Session` abstraction. Exposes `/events` with slice + cursor. |
| `A2A_TASK_DO` | Durable Object | One per `${tenant}#${task}`; A2A task lifecycle. |
| `APPROVALS_DO` | Durable Object | One per `${tenant}#${approval}`; serializes concurrent `decide` writes. |
| `FEDERATION_DO` | Durable Object | Singleton; holds the cached active `PolicyBundle`. |
| `TENANT_RATE_LIMIT` | Rate Limiting | Sliding window, 100 req/60s per tenant. Soft-fails open if absent. |

## Environment variables

Set under `vars` in `wrangler.jsonc` (per-env overrides supported).

| Var | Required | Notes |
|---|---|---|
| `ENVIRONMENT` | yes | `"development"`, `"staging"`, or `"production"`. Controls SSRF strictness, federation signature enforcement, and at-rest-key fail-closed behavior. |
| `AI_GATEWAY_SLUG` | yes | Account-scoped AI Gateway slug, e.g. `felix-prod`. |
| `AI_GATEWAY_ACCOUNT_ID` | yes | Cloudflare account id for AI Gateway. |
| `DEFAULT_MODEL_ID` | yes | Logical model id used when a manifest's `spec.model.id` is empty. |
| `MODEL_ROUTES` | optional | JSON map override of logical id → `{ provider, model }`. Unset = the `DEFAULT_MODEL_ROUTES` baked into `src/env.ts`. Set only to diverge per env (canary models, region routing). See below. |
| `JWT_VERIFIERS` | optional | The sole inbound-auth config. Comma-separated verifiers; each is whitespace-separated `<scheme> <issuer> [audience]` (scheme ∈ `access` \| `cognito`). Empty = no verifiers (every bearer rejected in non-dev). See examples below. |
| `POLICY_BUNDLE_KEY` | optional | R2 key for the active signed `PolicyBundle` (default `bundles/active.json`). |
| `SSRF_ALLOW_HOSTS` | optional | Comma-separated hostname allow-list for outbound (mcp/peers). |
| `CONTINUOUS_EVAL` | optional | JSON tuning for the continuous-eval cron (`sample_rate` / `max_replays_per_tick` / `window_ms`); bad values degrade to defaults. |
| `AUDIT_RETENTION_DAYS` | optional | Retention window (days) for the `retention_sweep` cron's `audit_events` prune. Parsed defensively (default 90, clamped `[7, 3650]`). |
| `ARTIFACT_RETENTION_DAYS` | optional | Retention window (days) for the `retention_sweep` cron's R2 artifact-spill prune. Parsed defensively (default 30, clamped `[1, 3650]`). |
| `CONVERSATION_IDLE_TTL_DAYS` | optional | Idle-TTL (days) after which a `ConversationDO` thread's storage is deleted by its DO alarm. Parsed defensively (default 90, clamped `[1, 3650]`). |
| `GEO_MONITOR` | optional | JSON tuning for the GEO monitor cron (engine model, `max_queries_per_tick`, window). |
| `ACP_MERCHANT_TENANT` | optional | Tenant that owns the ACP merchant surface (default `default`). |
| `COMMERCE_*` / `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` / `STRIPE_AUTOMATIC_TAX` / `BILLING_PROVIDER_DEFAULT` | optional | Commerce configuration (tax bps, shipping/carrier JSON, ship countries, recovery webhook, consent gate + terms/privacy, checkout redirects, billing default). See [the commerce data model + configuration docs](../../../commerce/docs/data-model.md). |

## Secrets

:::caution[Never commit secrets]
Set secrets with `pnpm exec wrangler secret put <NAME> --env <staging|production>` — the command prompts for the value. **Never** commit these to `wrangler.jsonc`. Use [`.dev.vars`](#local-dev-secrets) for local-only values; `wrangler dev` reads it but deployed envs do not.
:::

| Secret | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | for Anthropic models | Forwarded through AI Gateway as `x-api-key`. |
| `OPENAI_API_KEY` | for OpenAI models | Forwarded through AI Gateway as `authorization: Bearer ...`. |
| `CF_AIG_TOKEN` | when slug has Authenticated Gateway on | Sent as `cf-aig-authorization: Bearer ${token}` on every gateway call. Generate per-slug in the dashboard. Leave unset for unauthenticated gateways. |
| `POLICY_BUNDLE_PUBKEY` | staging/prod (if federation) | Base64-encoded raw Ed25519 public key (32 bytes). In dev, signature verification logs a warning and proceeds. |
| `OAUTH_CACHE_KEY` | staging/prod | Base64-encoded 32-byte AES-256 key for encrypting `oauth_token_cache.access_token`. In dev, missing key falls back to plaintext with a one-shot warning. |
| `CONSUMER_SHARED_SECRET` | when any manifest declares `spec.queues[]` or entity push is used | Shared secret on `POST /internal/sessions/:thread_id/events` and `POST /entities/:type/push`. Consumers send it as `x-consumer-secret`. Generate with `openssl rand -base64 32` and put it on **both** the Felix Worker and every consumer Worker. Missing on Felix → the route returns 503 (refuses to authenticate anyone). The secret is fleet-global, so the write-back also **pairs** each `tool_result` to an outstanding `queue_dispatch` audit row for that tenant + thread: a `tool_call_id` with no matching dispatch, or one already resolved (`queue_complete`/`queue_expired`), is rejected 409 and nothing is written. Because the dispatch row lands via `AUDIT_QUEUE` (eventually consistent), a consumer that finishes before the audit batch flushes may see a transient 409 — retry with backoff. |
| `STRIPE_SECRET_KEY` | for commerce checkout / billing | Stripe API key (`sk_…`). Without it `commerce_checkout`, ACP complete, and Stripe invoicing return not-configured errors; the rest of the harness is unaffected. |
| `STRIPE_WEBHOOK_SECRET` | for commerce webhooks | Stripe webhook signing secret (`whsec_…`) verifying `POST /commerce/stripe/webhook` and `POST /b2b/billing/webhook`. |
| `ACP_API_KEY` | for the `/acp` surface | Bearer key external buyer agents present; compared in constant time. Unset → `/acp` returns 503 `not_configured`. |
| `JWKS_PUBLIC` | for self-issued JWTs | JWKS JSON document served at `/.well-known/jwks.json` and used to verify self-issued tokens (mint with `scripts/mint-jwt.ts`). Staging/prod use this for scoped control-plane writes. |

### First-time setup checklist

<Steps>

1. **Set required secrets**

   ```bash
   pnpm exec wrangler secret put ANTHROPIC_API_KEY --env <staging|production>
   pnpm exec wrangler secret put OAUTH_CACHE_KEY --env <staging|production>
   ```

2. **Set optional secrets** (as needed)

   ```bash
   pnpm exec wrangler secret put POLICY_BUNDLE_PUBKEY --env <staging|production>  # if federation is on
   pnpm exec wrangler secret put CF_AIG_TOKEN --env <staging|production>           # if Authenticated Gateway is on
   pnpm exec wrangler secret put CONSUMER_SHARED_SECRET --env <staging|production> # if any manifest declares spec.queues[]
   # OPENAI_API_KEY only if a manifest routes to provider: openai
   ```

3. **Verify secrets are present**

   ```bash
   pnpm exec wrangler secret list --env <staging|production>
   ```

   Secret names show up but values do not.

4. **Apply migrations**

   ```bash
   pnpm migrate:staging    # or migrate:production
   ```

   :::caution
   There is intentionally no `migrate:remote` script. Remote migrations are destructive and must name an environment explicitly — use `migrate:staging` or `migrate:production`.
   :::

5. **Deploy**

   ```bash
   pnpm build:manifests
   pnpm deploy:staging     # wrangler deploy --env staging
   # or:
   pnpm deploy             # wrangler deploy --env production
   ```

   :::note
   Never invoke `wrangler deploy` without `--env` against this config — it targets the top-level placeholder bindings, not a real environment.
   :::

</Steps>

### AI Gateway slugs

The `AI_GATEWAY_SLUG` value must be an **already-existing** slug in the [Cloudflare AI Gateway dashboard](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway). Default config expects:

- `felix-dev` (top-level / `wrangler dev`)
- `felix-staging` (env.staging)
- `felix-prod` (env.production)

:::caution[Ambiguous 2009 error]
A non-existent slug returns `code 2009 Unauthorized` from the gateway URL — **the same response as Authenticated Gateway rejecting an unauthed call**, so the diagnostic is ambiguous. If you see 2009: confirm the slug exists *and* check whether Authenticated Gateway is on.
:::

**Authenticated Gateway** (a per-slug toggle in the dashboard) requires every gateway call to send a `cf-aig-authorization: Bearer ${token}` header. The model client honors `env.CF_AIG_TOKEN` automatically — set it via `wrangler secret put CF_AIG_TOKEN --env <staging|production>` after generating the token in the slug's settings page. Recommended for staging/prod (defends against a leaked `ANTHROPIC_API_KEY` being usable by anyone who knows the gateway URL); leave OFF for `felix-dev` so local work doesn't need a token.

### Local dev secrets

`wrangler dev` reads `apps/api/.dev.vars` (gitignored). Copy `apps/api/.dev.vars.example` to `apps/api/.dev.vars` and fill in. None of these propagate to staging or production — those envs are populated only via `wrangler secret put`.

Generate the at-rest key:

```bash
openssl rand -base64 32 | pnpm wrangler secret put OAUTH_CACHE_KEY --env production
```

Generate an Ed25519 keypair:

```bash
openssl genpkey -algorithm Ed25519 -out federation.pem
openssl pkey -in federation.pem -pubout -outform DER | tail -c 32 | base64 \
  | pnpm wrangler secret put POLICY_BUNDLE_PUBKEY --env production
```

## MODEL_ROUTES

A JSON object mapping logical model ids (what a manifest writes) to physical routes (`{ provider, model }`). Resolved by `parseModelRoutes(env)` at startup (`src/env.ts`); unset or unparseable values fall back to the baked-in `DEFAULT_MODEL_ROUTES`.

Currently shipped routes (`DEFAULT_MODEL_ROUTES` in `src/env.ts`):

```json title="Default model routes"
{
  "claude-sonnet-4":   { "provider": "anthropic",   "model": "claude-sonnet-4-6" },
  "claude-opus-4":     { "provider": "anthropic",   "model": "claude-opus-4-8" },
  "claude-haiku-4":    { "provider": "anthropic",   "model": "claude-haiku-4-5" },
  "llama-3-fast":      { "provider": "workers-ai",  "model": "@cf/meta/llama-3.1-8b-instruct" },
  "llama-3-pro":       { "provider": "workers-ai",  "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }
}
```

A manifest's `spec.model.id: "claude-sonnet-4"` will dispatch to Anthropic via the gateway slug for the current env (`${AI_GATEWAY_BASE}/${AI_GATEWAY_SLUG}/anthropic/v1/messages`). For Workers AI logical ids the runtime calls `env.AI.run(...)` directly — no AI Gateway round-trip. The `provider` field is a key into the open model-provider registry; built-ins (`anthropic`, `openai`, `workers-ai`) self-register at module load. New providers can be added via `registerModelProvider(name, factory)` from `apps/api/src/composition.ts` without editing `src/patterns/model.ts` — see [internals/model-client.md](../internals/model-client.md).

Tool calling on Workers AI requires a tool-capable model. The current whitelist (`src/patterns/model.ts`):

- `@hf/nousresearch/hermes-2-pro-mistral-7b`
- `@cf/meta/llama-3.1-8b-instruct`
- `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `@cf/mistralai/mistral-small-3.1-24b-instruct`

Other Workers AI models still answer, but tool_calls will be empty and the react loop will terminate after the first model turn.

## JWT_VERIFIERS

Inbound JWT verification is configured entirely through this one var (`parseVerifiers` in `src/auth/jwt.ts`) — there are no provider-specific vars. It's a comma-separated list of verifiers; each verifier is whitespace-separated `<scheme> <issuer> [audience]` (whitespace delimits the fields so issuer URLs, which contain colons, parse unambiguously). Two schemes are supported; the scheme only selects how the JWKS URL is derived. Malformed or unknown-scheme entries are skipped.

<Tabs>
<TabItem label="Cloudflare Access">

`issuer` is the team host; JWKS is fetched from `https://<issuer>/cdn-cgi/access/certs` and cached for 1 hour:

```jsonc title="wrangler.jsonc"
"vars": {
  "JWT_VERIFIERS": "access acme.cloudflareaccess.com 01234abc-aud-claim"
}
```

</TabItem>
<TabItem label="Cognito / OIDC">

`issuer` is the full issuer URL; JWKS is at `<issuer>/.well-known/jwks.json`:

```jsonc title="wrangler.jsonc"
"vars": {
  "JWT_VERIFIERS": "cognito https://cognito-idp.us-west-2.amazonaws.com/us-west-2_AbCdEfGhI client-id-here"
}
```

</TabItem>
<TabItem label="Both at once">

Comma-separate the verifiers (the loop tries each in order):

```jsonc title="wrangler.jsonc"
"vars": {
  "JWT_VERIFIERS": "access acme.cloudflareaccess.com my-aud, cognito https://cognito-idp.us-west-2.amazonaws.com/us-west-2_AbCdEfGhI client-id-here"
}
```

</TabItem>
</Tabs>

Tenant id is derived from JWT claims in this order: `custom:tenant_id` → `tenant_id` → first label of the issuer hostname → `default`.

:::note[Anonymous and bearer behavior]
Anonymous traffic (no `Authorization` header) is always accepted by the middleware; the route then decides whether the manifest allows it via `auth.inbound.allow_anonymous`. A bearer with an unrecognized issuer demotes to anonymous in dev (so unit tests pass) and is rejected with 401 in staging/production. An expired or malformed bearer always 401s.
:::

## SSRF allow-list

Outbound URLs from `mcp_servers` and `peers` are checked at parse time and again before every fetch. The defaults block:

- non-HTTPS (except `localhost` in development)
- loopback (`127.0.0.1`, `::1`)
- RFC1918 (`10/8`, `172.16/12`, `192.168/16`)
- link-local (`169.254/16`, `fe80::/10`)
- IPv6 ULA (`fc00::/7`)
- `.internal`, `.cluster.local`, `.svc`, `.svc.cluster.local`

To override for explicit internal-network targets:

```jsonc title="wrangler.jsonc"
"vars": {
  "SSRF_ALLOW_HOSTS": "mcp.internal.example,billing.svc.cluster.local"
}
```

## Container gateways

Manifests can declare container-backed tools under `spec.containers[]`. Each entry becomes a `Tool` whose executor is a `ContainerExecutor` pointing at an HTTPS gateway. Felix is **transport-agnostic** — the gateway can be a Cloudflare Container, an internal sandbox service, or an external code-exec provider. The gateway only has to accept this protocol:

```
POST {gateway_url}
{ "image": "<image>", "tool": "<container_tool_name>", "arguments": { ... } }

200 { "content": "...", "exit_code"?: number, "stderr"?: string }
```

See [manifest-reference.md#speccontainers](manifest-reference.md#speccontainers) for the manifest field reference and [`examples/python-sandbox/`](../../examples/python-sandbox/) for an end-to-end sample (a 30-line mock-gateway Worker plus the manifest that calls it).

### Wiring a real Cloudflare Container

When CF Containers GA, the wiring is:

<Steps>

1. Build the image (Dockerfile in `examples/python-sandbox/runtime/`) and push to a registry accessible from your account.

2. Register the container binding in `wrangler.jsonc`:

   ```jsonc title="wrangler.jsonc"
   "containers": [
     {
       "name": "PYTHON_SANDBOX",
       "image": "ghcr.io/yourorg/python-sandbox:latest",
       "instance_type": "standard"
     }
   ]
   ```

3. Deploy a thin gateway Worker (or co-host the gateway in this Worker) that translates `POST { image, tool, arguments }` into a `getContainer(env.PYTHON_SANDBOX).fetch(...)` call. The gateway is the trust boundary — it decides what images this caller is allowed to run, attaches any per-image secrets, and shapes the response.

4. Point the manifest's `gateway_url` at the gateway endpoint. Add the gateway host to `SSRF_ALLOW_HOSTS` if it's on a private network.

</Steps>

:::note[Credentials never reach the sandbox]
When `containers[].auth` is set, Felix asks the outbound auth broker for an `Authorization` header on the gateway request — the value never goes into `arguments`. If a manifest author needs a token *inside* the container, that's an explicit "put it in args" decision the author owns.
:::

## Cron triggers

```jsonc title="wrangler.jsonc"
"triggers": { "crons": ["*/10 * * * *"] }
```

Every 10 minutes the `scheduled` handler runs these in `waitUntil`, each guarded so one failure doesn't starve the rest (`apps/api/src/index.ts:scheduled`):

1. `federationStub(env).fetch('https://do/refresh')` — pulls the latest signed `PolicyBundle` from R2 and updates the `FederationDO` cache.
2. `runScheduledJobs(env)` — sweeps the `jobs` table for `next_run_at <= now`, re-verifies each schedule with `cronMatches`, records the run, and emits a `job_run` audit event.
3. `sweepOrphanQueueDispatches(env)` — reclaims `transport: queue` tool dispatches whose `tool_result` never landed.
4. `runAnomalyScan(env)` — fires `anomaly_detected` events when a tool's error rate exceeds its 24h EWMA baseline, and `auto_rollback` (zeroes `canary_weight`) when the flagged manifest is an active canary.
5. `runAbandonedCartScan(env)` — flags carts with purchase intent but no completed purchase (idle > 1h), records them, and posts to `COMMERCE_RECOVERY_WEBHOOK` when set.
6. `runContinuousEvalTick(env, tools, opts, now, ctx)` — online-benchmarks every in-flight canary: samples recent production inputs, replays each through the canary version, judges the result, and emits `judge_score` events tagged `payload.source: 'continuous'`. No-op when no canaries are live.
7. `runGeoMonitorTick(env, opts, now, ctx)` — replays tracked shopping queries (`geo_queries`) through a generative engine and records brand presence/rank into `geo_observations`. No-op when no queries are registered.

The whole body runs inside `runWithContext(buildAnonymousContext(env, ctx), …)` so audit events actually persist (cron runs outside `authMiddleware`).

### Supported cron syntax

5-field UTC (`minute hour day-of-month month day-of-week`). Implemented in `src/jobs/cron.ts:72-138`.

| Form | Example | Meaning |
|---|---|---|
| `*` | `*` | any value |
| literal | `5` | exact value |
| list | `1,3,5` | one of the listed values |
| range | `1-5` | inclusive range |
| step | `*/5` or `0-30/5` | every Nth value, optionally over a range |

Not supported: named day/month aliases, `L`, `W`, `#`.

## Custom domains

`wrangler.jsonc` routes each env to a `make.felix.run` subdomain:

| Env | Custom domain |
|---|---|
| development | `localhost:8787` |
| staging | `staging-make.felix.run` |
| production | `make.felix.run` |

Cloudflare provisions TLS certs automatically on first deploy.

## Federation bundle workflow

The signed bundle distributed via R2 is documented in [internals/governance.md](../internals/governance.md). The minimal flow:

<Steps>

1. Author the bundle JSON: `{ version, issuer, policies: [...], approvals: [...] }`.
2. Sign deterministically with the Ed25519 private key whose public key is in `POLICY_BUNDLE_PUBKEY`. The signing target is the JSON with `signature` removed, key-sorted (deterministic).
3. Set `signature` to the base64 Ed25519 signature.
4. Upload to R2:
   ```bash
   pnpm wrangler r2 object put felix-orchestrator-bundles-prod/<POLICY_BUNDLE_KEY> \
     --file=bundle.json --env production
   ```
5. The next cron tick refreshes the FederationDO cache; all isolates pick it up within 10 minutes.

</Steps>

:::note
In staging and production the bundle **must** verify or the previous active bundle is kept. In development the verification logs a warning but proceeds.
:::

## Deploy commands

```bash title="Reference"
pnpm build:manifests
pnpm migrate:staging                            # apply migrations to orchestrator-staging
pnpm migrate:production                         # apply migrations to orchestrator-prod

pnpm deploy:staging                             # wrangler deploy --env staging
pnpm deploy                                     # wrangler deploy --env production
```

Both `pnpm dev` and `pnpm deploy` rebuild manifests first.
