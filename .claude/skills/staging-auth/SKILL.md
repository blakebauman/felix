---
name: staging-auth
description: Authenticate against Felix staging/production management APIs — mint a self-issued RS256 JWT with packages/core/scripts/mint-jwt.ts and pick the right scopes.
when_to_use: 401 or 403 from staging or production, "mint a JWT", "call /manifests on staging", scoped write failing, requireScope, JWKS_PUBLIC, manifests:write, audit:read, bearer token.
---

# Staging / production auth

Management surfaces (`/manifests`, `/audit`, `/approvals`, `/jobs`, `/eval`, ...) require a per-surface scope via `requireScope`. Staging and production verify **self-issued** JWTs: the deployed Worker serves its own JWKS at `/.well-known/jwks.json` (from the `JWKS_PUBLIC` secret) and `JWT_VERIFIERS` points at its own domain.

## Mint a token

```bash
pnpm tsx packages/core/scripts/mint-jwt.ts --scope "manifests:read manifests:write" --tenant default
```

- First run generates a keypair at `.secrets/jwt-signing-key.json` (gitignored). **Never cat the private key** — run the script; the Read tool is denied on `.secrets/` anyway.
- Output is `{jwks, token}`. The deployed `JWKS_PUBLIC` secret must equal the printed `jwks` or verification fails with 401 (`wrangler secret put JWKS_PUBLIC --env staging`, run from `packages/core/`).
- Other flags: `--iss --sub --aud --ttl`.
- Use: `curl -H "Authorization: Bearer <token>" https://staging-make.felix.run/manifests`

## Scope catalog

`manifests:read` / `manifests:write`, `audit:read`, `approvals:read` / `approvals:decide`, `plans:read`, `jobs:read` / `jobs:write`, `eval:read` / `eval:write`, `consent:read`, `geo:write`, `brands:write`, `b2b:write`, `entities:write`.

## Edge cases

- **Local dev with no verifiers** (`JWT_VERIFIERS` empty in dev): scope gate falls open — no token needed.
- **Production with empty `JWT_VERIFIERS`**: bearer auth fails closed, but all traffic becomes anonymous `default` tenant — tenant isolation silently collapses. Never ship that.
- **`/acp`** uses `ACP_API_KEY` bearer and skips the JWT middleware entirely; **`/shop`, `/widget`, `/structured`** and discovery endpoints are public by design.

## Diagnosis

- 401 → token expired, wrong issuer/audience, or `JWKS_PUBLIC` doesn't match the signing key (re-mint and re-put the secret).
- 403 → token valid but missing the scope for that surface — re-mint with the scope from the catalog above.
