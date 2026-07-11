---
name: smoke-test
description: Verify a live Felix environment (staging or production) with unauthenticated probes, scoped-token probes, and an optional chat round-trip, then interpret failures.
when_to_use: 'Requests like "smoke test staging", "is production healthy", "verify the deploy", "check the API is up", or right after any deploy.'
---

# Smoke test a live environment

Target: `staging` → `https://staging-make.felix.run`, `production` → `https://make.felix.run`. Default staging. Bare `wrangler` commands run from `apps/api/` (where `wrangler.jsonc` lives).

## 1. Unauthenticated probes (expect 200)

```bash
curl -s -o /dev/null -w "%{http_code}" $BASE/health
curl -s -o /dev/null -w "%{http_code}" $BASE/openapi.json
curl -s -o /dev/null -w "%{http_code}" $BASE/.well-known/agent-card.json
curl -s -o /dev/null -w "%{http_code}" $BASE/.well-known/jwks.json
curl -s -o /dev/null -w "%{http_code}" $BASE/docs
```

## 2. Scoped probes (mint token per the staging-auth skill)

```bash
TOKEN=$(pnpm tsx apps/api/scripts/mint-jwt.ts --scope "manifests:read audit:read" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" $BASE/manifests | jq 'length'   # expect manifest list
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/audit?limit=1" | jq .    # expect 200, possibly empty
```

## 3. Optional chat round-trip (spends tokens — ask first on production)

```bash
curl -s $BASE/v1/chat/completions -H "content-type: application/json" \
  -d '{"model":"quick","messages":[{"role":"user","content":"ping"}]}' | jq '.choices[0].message.content'
```

## Interpret failures

| Symptom | Likely cause |
|---|---|
| 404 `unknown_manifest` on ALL manifests | Unapplied D1 migrations on that env — run `pnpm migrate:<env>` (known prod gotcha) |
| 401 on scoped routes | `JWKS_PUBLIC` doesn't match the local signing key, or token expired — re-mint + `wrangler secret put JWKS_PUBLIC --env <env>` |
| 403 on scoped routes | Token valid but missing the scope — re-mint with the right `--scope` |
| 500 on chat | Check provider secrets (`ANTHROPIC_API_KEY`, `CF_AIG_TOKEN`) and `wrangler tail` (observability skill) |
| `/health` down | Deploy failed or DNS/custom-domain issue — `wrangler deployments list --env <env>` |

## Output

Report a pass/fail table per probe with status codes, then the diagnosis + next step for any failure.
