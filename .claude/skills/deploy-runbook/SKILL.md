---
name: deploy-runbook
description: Deploy Felix to staging or production following the apps/api/scripts/deploy.md runbook — Postgres migrations before deploy, secrets, Hyperdrive config, smoke tests.
disable-model-invocation: true
argument-hint: "[staging|production]"
---

# Deploy runbook

Target env: `$ARGUMENTS` (default: **staging**). Read `apps/api/scripts/deploy.md` first for first-time deploys — it is the source of truth; this is the recurring-deploy summary. `pnpm` scripts run from the repo root; bare `wrangler` commands run from `apps/api/` (where `wrangler.jsonc` lives).

## Order matters — do not reorder

1. **Checks green locally**: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
2. **Migrations to the TARGET env BEFORE deploying code**:
   - staging: `pnpm migrate:staging`
   - production: `pnpm migrate:production`
   An unapplied prod migration makes the manifest resolver 404 every manifest — the whole API looks down. Check pending with `DATABASE_URL=<env's Neon DIRECT url> pnpm migrate:<env> -- --dry-run` (node-pg-migrate; also visible in the `pgmigrations` table).
3. **Secrets present** on the target env (only when new/rotated — `wrangler secret put <NAME> --env <env>`): `OAUTH_CACHE_KEY` (encrypt throws without it), `POLICY_BUNDLE_PUBKEY` (federation refresh no-ops / rejects unsigned bundles), `JWKS_PUBLIC` (self-issued auth; must match `apps/api/scripts/mint-jwt.ts` keypair — see the staging-auth skill), plus provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CF_AIG_TOKEN`) and Stripe/ACP secrets if commerce is exercised.
4. **Hyperdrive** (first deploy or credential rotation only): config must exist per env (`wrangler hyperdrive create felix-hyperdrive-<env> --connection-string='<Neon DIRECT url>' --caching-disabled`) with its id in `wrangler.jsonc`; rotate credentials with `wrangler hyperdrive update`.
5. **Deploy**: `pnpm deploy:staging` or `pnpm deploy` (production). Both run the bundle builds first.
6. **Smoke test**: run the smoke-test skill against the target (`/smoke-test staging` or `/smoke-test production`) — at minimum `/health`, `/manifests` (with token), `/openapi.json` on `staging-make.felix.run` / `make.felix.run`.

## If something is wrong post-deploy

- All manifests 404 → step 2 was skipped (migrations gap).
- 401 on scoped routes → `JWKS_PUBLIC` mismatch (staging-auth skill).
- Use the observability skill (`wrangler tail`, `/audit`) to diagnose anything else. Manifest-level rollback (canary weight, active-pointer rollback) is in the manifest-ops skill — often faster than redeploying.
