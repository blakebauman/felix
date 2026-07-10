# Getting Started

This walks through standing up Felix locally and making your first request. Felix is a [managed agents harness](https://www.anthropic.com/engineering/managed-agents) on Cloudflare Workers — the runtime owns plumbing (auth, audit, limits, session persistence, HTTP surface) and a manifest declares the agent's pattern, model, tools, and governance. For the mental model, read [concepts.md](concepts.md) after this. For deployment to staging or production, see [deploy.md](deploy.md).

## Prerequisites

- Node.js 20 or newer
- `pnpm` 9 or newer
- Wrangler 4 (installed transitively via `pnpm install`)
- A Cloudflare account with D1, KV, R2, Vectorize, and Queues enabled
- For external LLM providers: an Anthropic and/or OpenAI API key (Workers AI requires no extra setup)

## Bootstrap

Clone the repo, install dependencies, and create the Cloudflare resources Felix needs.

```bash
git clone <repo-url> felix && cd felix
pnpm install
cp wrangler.example.jsonc wrangler.jsonc

pnpm wrangler d1 create orchestrator
pnpm wrangler kv namespace create CACHE
pnpm wrangler r2 bucket create felix-orchestrator-bundles
pnpm wrangler vectorize create felix-memory --dimensions=768 --metric=cosine
pnpm wrangler queues create felix-audit
```

`wrangler.jsonc` is your local copy of the tracked template `wrangler.example.jsonc` — it's gitignored so account-specific ids stay out of the repo. Paste the `database_id` and KV namespace `id` from the create commands into it (lines that say `REPLACE_AFTER_wrangler_d1_create` / `REPLACE_AFTER_wrangler_kv_create`), along with your `AI_GATEWAY_ACCOUNT_ID`.

Vectorize must be created with 768 dimensions to match `@cf/baai/bge-base-en-v1.5`, the embedding model Felix uses for semantic memory.

Configure local secrets by copying the example file and filling in values:

```bash
cp .dev.vars.example .dev.vars
$EDITOR .dev.vars
```

`wrangler dev` reads `.dev.vars` automatically — it is **not** used by deployed envs. The minimum to send a request through the default `claude-sonnet-4` route is `ANTHROPIC_API_KEY`. The other variables in the template:

- `OPENAI_API_KEY` — only required if a manifest routes to a `provider: openai` model.
- `CF_AIG_TOKEN` — only required when the AI Gateway slug has Authenticated Gateway enabled in the dashboard (the default `felix-dev` slug does not).
- `OAUTH_CACHE_KEY` — base64 32-byte AES-256 key for encrypting `oauth_token_cache` rows. Optional in dev (falls back to plaintext with a warning); required in staging/production. Generate with `openssl rand -base64 32`.
- `POLICY_BUNDLE_PUBKEY` — base64-encoded Ed25519 raw public key (32 bytes) for verifying the federation `PolicyBundle` signature. Optional in dev (unsigned bundles produce a warning); required in staging/production.

For deployed envs, set the same values with `pnpm exec wrangler secret put <NAME> --env <staging|production>` — see [deploy.md](deploy.md).

## Build and run

```bash
pnpm build:manifests   # YAML manifests + SKILL.md -> src/manifests/bundled.ts + src/skills/bundled.ts
pnpm migrate:local     # apply D1 schema to local SQLite
pnpm dev               # wrangler dev on http://localhost:8787
```

`pnpm dev` reruns `build:manifests` first. It bundles this repo's own `manifests/*.yaml` and `skills/*/SKILL.md`; if those directories are empty the bundle is empty — tests in this repo stub manifests directly through `parseManifest` and `_clearManifestCaches`.

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

Suffixes containing `:` or `#` are rejected with HTTP 400 so the tenant prefix cannot be smuggled away.

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

- [concepts.md](concepts.md) — the mental model behind manifests, tenants, threads, patterns
- [manifest-reference.md](manifest-reference.md) — write your own manifest
- [rest-api.md](rest-api.md) — every public endpoint with worked curl examples
- [deploy.md](deploy.md) — bindings, secrets, custom domains for staging and production
