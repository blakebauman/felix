---
description: "Stand up Felix locally, create Cloudflare resources, and make your first chat request."
---

# Getting Started

This walks through standing up Felix locally and making your first request. Felix is a [managed agents harness](https://www.anthropic.com/engineering/managed-agents) on Cloudflare Workers — the runtime owns plumbing (auth, audit, limits, session persistence, HTTP surface) and a manifest declares the agent's pattern, model, tools, and governance. For the mental model, read [concepts.md](concepts.md) after this. For deployment to staging or production, see [deploy.md](deploy.md).

## Prerequisites

- Node.js 20 or newer
- `pnpm` 9 or newer
- Wrangler 4 (installed transitively via `pnpm install`)
- Docker (for the local Postgres + pgvector container used by `pnpm db:up`)
- A Cloudflare account with Hyperdrive, KV, R2, and Queues enabled
- A [Neon](https://neon.tech) Postgres project (staging/production; local dev uses the Dockerized Postgres instead) with the `vector` and `pg_trgm` extensions available
- For external LLM providers: an Anthropic and/or OpenAI API key (Workers AI requires no extra setup)

## Bootstrap

<Steps>

1. **Clone the repo and install dependencies**

   ```bash
   git clone <repo-url> felix && cd felix
   pnpm install
   cp apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc
   ```

   `apps/api/wrangler.jsonc` is your local copy of the tracked template — it's gitignored so account-specific ids stay out of the repo.

2. **Start local Postgres**

   ```bash title="From the repo root"
   pnpm db:up
   ```

   Brings up a Dockerized `pgvector/pgvector:pg17` container (`docker compose up --wait -d db`) that `wrangler dev` routes the `HYPERDRIVE` binding to via `localConnectionString` — no Neon project or Hyperdrive config needed for local dev.

3. **Create Cloudflare resources**

   Bare `wrangler` commands run from `apps/api/`:

   ```bash
   cd apps/api
   pnpm wrangler kv namespace create CACHE
   pnpm wrangler r2 bucket create felix-orchestrator-bundles
   pnpm wrangler queues create felix-audit
   ```

   Staging/production also need a Hyperdrive config pointed at a Neon **DIRECT** connection string (no `-pooler` suffix — Hyperdrive owns pooling) with caching disabled, since Felix depends on read-after-write:

   ```bash
   pnpm wrangler hyperdrive create felix-hyperdrive-staging \
     --connection-string='postgresql://<user>:<pass>@<neon-direct-host>/<db>' --caching-disabled
   ```

   :::note
   Local `pnpm dev` never touches a real Hyperdrive config — it always routes through the Docker Postgres started in the previous step.
   :::

4. **Populate wrangler.jsonc with resource ids**

   Paste the Hyperdrive config `id` and KV namespace `id` from the create commands into `wrangler.jsonc` (lines that say `REPLACE_AFTER_wrangler_hyperdrive_create` / `REPLACE_AFTER_wrangler_kv_create`), along with your `AI_GATEWAY_ACCOUNT_ID`.

5. **Configure local secrets**

   :::caution
   Never commit secret values to `wrangler.jsonc`. Use `.dev.vars` for local-only values; `wrangler dev` reads it but deployed environments do not.
   :::

   ```bash
   cp apps/api/.dev.vars.example apps/api/.dev.vars
   $EDITOR apps/api/.dev.vars
   ```

   The minimum to send a request through the default `claude-sonnet-4` route is `ANTHROPIC_API_KEY`. Other variables in the template:

   | Variable | When needed |
   |---|---|
   | `OPENAI_API_KEY` | Only if a manifest routes to `provider: openai`. |
   | `CF_AIG_TOKEN` | Only when the AI Gateway slug has Authenticated Gateway enabled. |
   | `OAUTH_CACHE_KEY` | Optional in dev (plaintext fallback with warning); required in staging/prod. Generate: `openssl rand -base64 32`. |
   | `POLICY_BUNDLE_PUBKEY` | Optional in dev (unsigned bundles warn and proceed); required in staging/prod. |

</Steps>

## Build and run

<Steps>

1. **Build manifests**

   ```bash title="From the repo root"
   pnpm build:manifests
   ```

   This reads `packages/harness/manifests/*.yaml` and `packages/harness/skills/*/SKILL.md`, validates each against the Zod schema, and emits `packages/harness/src/{manifests,skills}/bundled.ts`. Empty directories → empty bundles (tests stub manifests directly via `parseManifest`).

2. **Apply local DB migrations**

   ```bash
   pnpm migrate:local
   ```

   Applies `apps/api/migrations/0001_baseline.sql` (node-pg-migrate) to the local `felix` database started by `pnpm db:up`. Run this before `pnpm dev` any time the schema changes.

3. **Start the dev server**

   ```bash
   pnpm dev
   ```

   Runs `build:manifests` first, then `wrangler dev` on `http://localhost:8787`.

</Steps>

## First request — Felix-native `/chat`

The bundled default manifest is named `quick`. Send an anonymous request:

```bash
curl -s -X POST http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -d '{
    "manifest": "quick",
    "messages": [{ "role": "user", "content": "What is 7 * 6?" }]
  }' | jq
```

Response shape:

```json
{
  "messages": [
    { "role": "user", "content": "What is 7 * 6?" },
    { "role": "assistant", "content": "7 * 6 = 42." }
  ],
  "final": { "role": "assistant", "content": "7 * 6 = 42." },
  "thread_id": null
}
```

To persist the transcript across requests, pass a `thread_id` (the server prefixes your tenant id so the value you supply is a suffix):

```bash
curl -s -X POST http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -d '{
    "manifest": "quick",
    "thread_id": "session-1",
    "messages": [{ "role": "user", "content": "And times 10?" }]
  }' | jq
```

:::note
Suffixes containing `:` or `#` are rejected with HTTP 400 so the tenant prefix cannot be smuggled away.
:::

## First request — OpenAI-shaped `/v1`

Drop-in for any OpenAI SDK client. The `model` field is a Felix manifest name (run `GET /v1/models` to list them):

```bash
curl -s -X POST http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-thread-id: openai-session-1' \
  -d '{
    "model": "quick",
    "messages": [{ "role": "user", "content": "Say hi." }]
  }' | jq
```

Add `"stream": true` to receive `text/event-stream` chunks instead of a single JSON response.

For authenticated requests, supply a Cloudflare Access or Cognito JWT in the `Authorization` header. Without it the request is anonymous and only manifests with `auth.inbound.allow_anonymous: true` will accept it. See [auth.md](../internals/auth.md) for verifier configuration.

## Where to next

<CardGrid>
  <LinkCard title="Concepts" href="/guide/concepts/" description="The mental model behind manifests, tenants, threads, patterns." />
  <LinkCard title="Manifest Reference" href="/guide/manifest-reference/" description="Write your own manifest — every field with defaults." />
  <LinkCard title="REST API" href="/guide/rest-api/" description="Every public endpoint with worked curl examples." />
  <LinkCard title="Deploy" href="/guide/deploy/" description="Bindings, secrets, custom domains for staging and production." />
</CardGrid>
