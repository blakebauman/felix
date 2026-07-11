# Deploy runbook

First-time deploy of the Felix orchestrator. Each section's commands are
**ordered** — running them out of order will break the worker on its first
request (missing migration → SQL errors, missing `OAUTH_CACHE_KEY` →
encrypt throws, missing `POLICY_BUNDLE_PUBKEY` → federation refresh is a
no-op).

Bare `wrangler` (and the `cp`) commands below run from `apps/api/` — where
`wrangler.jsonc` lives; `pnpm` scripts run from the repo root.

Custom domains (see `wrangler.jsonc` — adjust to your zone):
- staging → `staging-make.felix.run`
- production → `make.felix.run`

Cert provisioning happens on first deploy; allow ~30s.

---

## 0. Prereqs

```bash
# Logged into the right Cloudflare account
wrangler whoami

# wrangler.jsonc exists locally (gitignored copy of the tracked template)
cp -n wrangler.example.jsonc wrangler.jsonc

# Working tree clean and tests green
pnpm typecheck && pnpm lint && pnpm test
```

---

## 1. Create staging resources

Each `create` prints an id; paste it into the corresponding `REPLACE_AFTER_*`
placeholder in `wrangler.jsonc` under `env.staging`.

```bash
# D1
wrangler d1 create orchestrator-staging
# → copy database_id into env.staging.d1_databases[0].database_id

# KV
wrangler kv namespace create CACHE --env staging
# → copy id into env.staging.kv_namespaces[0].id

# R2
wrangler r2 bucket create felix-orchestrator-bundles-staging

# Vectorize (768 dims = bge-base-en-v1.5; matches packages/harness/src/memory/store.ts)
wrangler vectorize create felix-memory-staging --dimensions 768 --metric cosine

# Queue
wrangler queues create felix-audit-staging
```

---

## 2. Set staging secrets

```bash
# OAuth token-cache at-rest key (AES-256, 32 bytes base64).
# Rotation later: re-run this — old ciphertexts fail gracefully to refetch.
openssl rand -base64 32 | wrangler secret put OAUTH_CACHE_KEY --env staging

# PolicyBundle signing pubkey (Ed25519). Generate the keypair locally;
# put the public key in the secret, keep the private key on the bundle
# publisher.
openssl genpkey -algorithm Ed25519 -out /tmp/felix-bundle.pem
openssl pkey -in /tmp/felix-bundle.pem -pubout -outform DER \
  | tail -c 32 | base64 \
  | wrangler secret put POLICY_BUNDLE_PUBKEY --env staging
# Save /tmp/felix-bundle.pem somewhere durable — you need it to re-sign
# bundles before publishing them to R2.

# Provider API keys (optional; only if a manifest hits Anthropic / OpenAI
# directly rather than through AI Gateway).
# wrangler secret put ANTHROPIC_API_KEY --env staging
# wrangler secret put OPENAI_API_KEY --env staging
```

---

## 3. Apply D1 migrations (remote)

**Do this before the first deploy** — the `jobs` table change in `0002`
is load-bearing and the worker's `jobs/store.ts` assumes it.

```bash
pnpm migrate:staging     # wrangler d1 migrations apply orchestrator-staging --env staging --remote
```

Verify:

```bash
wrangler d1 execute orchestrator-staging --env staging --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

You should see the harness core (`audit_events`, `approvals`, `jobs`,
`oauth_token_cache`, `plans`, `skill_activation`, `manifests`,
`manifest_active`, `eval_*`) plus the commerce tables from migrations
0006–0018 (`products`, `orders`, `acp_checkout_sessions`, `brands`,
`accounts`, `quotes`, `invoices`, `geo_queries`, `consents`,
`customers`, `pricing_rules`, …). Missing commerce tables mean an
unapplied migration — the resolver will 404 every manifest until the
migration set is complete.

---

## 4. Deploy staging worker

```bash
pnpm deploy:staging      # runs build:manifests, then wrangler deploy --env staging
```

Cert for `staging-make.felix.run` provisions in the background.

Smoke test:

```bash
curl https://staging-make.felix.run/health
curl https://staging-make.felix.run/v1/models
curl https://staging-make.felix.run/.well-known/agent-card.json
```

---

## 5. Re-sign and publish the PolicyBundle

The bundle format changed in this hardening pass: the signature now covers
the canonical-JSON view of the bundle minus `.signature`. Old unsigned
bundles in R2 will be rejected.

```bash
# Sign your bundle.json (see packages/harness/src/policy/bundle.ts for the canonical-JSON
# rule — sort keys at every level, then sign with the Ed25519 private key).
# Write the result to bundle-signed.json with `.signature` set to base64
# of the raw 64-byte signature.

wrangler r2 object put felix-orchestrator-bundles-staging/bundles/active.json \
  --file bundle-signed.json
```

Trigger a refresh by waiting up to 10 minutes (cron) or pinging:

```bash
# Manual cron trigger via wrangler tail in another window is the easiest
# way to confirm; otherwise watch logs for "PolicyBundle signature verified".
wrangler tail --env staging
```

---

## 6. Production (after staging soak)

Repeat steps 1–5 with `--env production` (`pnpm migrate:production`,
`pnpm deploy`), replacing names with the `-prod` variants and the custom
domain with `make.felix.run`. If the commerce surfaces are in use, also
set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `ACP_API_KEY`
(see [the deploy guide](../../../packages/harness/docs/guide/deploy.md#secrets)).

---

## Rollback

```bash
# Roll back to a previous version.
wrangler rollback --env production
```

`oauth_token_cache` rows under a rotated key fail gracefully — the worker
refetches under the new key — so rollback doesn't corrupt cached state.
