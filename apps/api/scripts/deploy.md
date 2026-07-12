# Deploy runbook

First-time deploy of the Felix orchestrator. Each section's commands are
**ordered** — running them out of order will break the worker on its first
request (missing migration → 404 unknown_manifest on everything, missing `OAUTH_CACHE_KEY` →
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
# Neon (console or CLI): one project; the DEFAULT branch is production.
# Create a child branch `staging` and copy its DIRECT connection string
# (host WITHOUT the `-pooler` suffix — Hyperdrive replaces Neon's pooler).
# Keep the direct URLs in your password manager: migrations use them, the
# Worker never sees them (it only reads env.HYPERDRIVE.connectionString).

# Hyperdrive — MUST be --caching-disabled: Felix depends on read-after-write
# (approvals CAS, manifest activate→resolve, checkout).
wrangler hyperdrive create felix-hyperdrive-staging \
  --connection-string='<staging DIRECT url>' --caching-disabled
# → copy id into env.staging.hyperdrive[0].id

# KV
wrangler kv namespace create CACHE --env staging
# → copy id into env.staging.kv_namespaces[0].id

# R2
wrangler r2 bucket create felix-orchestrator-bundles-staging

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

## 3. Apply Postgres migrations (remote)

**Do this before the first deploy.** node-pg-migrate runs over the branch's
DIRECT connection string — never through Hyperdrive (transaction pooling +
caching are wrong for DDL), never via wrangler.

```bash
DATABASE_URL='<staging DIRECT url>' pnpm migrate:staging
```

Verify (psql against the same direct URL):

```bash
psql '<staging DIRECT url>' -c "\\dt"
psql '<staging DIRECT url>' -c "SELECT extname FROM pg_extension"   # expect vector + pg_trgm
```

You should see the harness core (`audit_events`, `approvals`, `jobs`,
`oauth_token_cache`, `plans`, `skill_activation`, `manifests`,
`manifest_active`, `eval_*`), `memory_vectors`, and the commerce tables
(`products`, `orders`, `acp_checkout_sessions`, `brands`, `accounts`,
`quotes`, `invoices`, `geo_queries`, `consents`, `customers`,
`pricing_rules`, …) plus node-pg-migrate's `pgmigrations` bookkeeping
table. A missing table means an unapplied migration — the resolver will
404 every manifest until the schema is complete.

---

## 4. Deploy staging worker

```bash
pnpm deploy:staging      # runs build:manifests, then wrangler deploy --env staging
```

Cert for `staging-make.felix.run` provisions in the background.

Smoke test (see the smoke-test skill for the full suite):

```bash
curl https://staging-make.felix.run/health
curl https://staging-make.felix.run/v1/models
curl https://staging-make.felix.run/.well-known/agent-card.json
# Postgres-backed read-after-write proof (also proves caching is disabled):
# create a manifest version, activate it, resolve it — see manifest-ops skill.
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

Repeat steps 1–5 with `--env production` (`DATABASE_URL='<prod DIRECT url>'
pnpm migrate:production`, `pnpm deploy`), replacing names with the `-prod`
variants (`felix-hyperdrive-prod` against the Neon DEFAULT branch) and the
custom domain with `make.felix.run`. If the commerce surfaces are in use, also
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
