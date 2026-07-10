---
name: review-security
description: Security review of Felix changes — tenant isolation, scope gating, secret handling, SSRF/injection, signature verification, fail-open vs fail-closed defaults.
when_to_use: 'Requests like "security review", "is this safe", "check tenant isolation", "review auth", or before merging changes touching auth, D1 queries, routes, secrets, or outbound fetches.'
---

# Review: security

## Target

Default: current diff (`git diff` + `git diff --cached`, or `git diff main...HEAD`). Delegate large diffs to the **felix-reviewer** subagent with this checklist as the lens.

## Checklist

- **Tenant isolation (highest priority)**: every D1 query filters `tenant_id`; new tables use tenant-first composite PKs; no query builds tenant scope from user-controllable input other than the authenticated context. `packages/core/tests/integration/cross_tenant.test.ts` must cover new tables.
- **Authorization**: every new management route is gated by `requireScope('<surface>:<verb>')`; the dev fall-open (no verifiers) must not extend to staging/production paths; `/acp` (ACP_API_KEY bearer, skips JWT middleware) and the public surfaces (`/shop`, `/widget`, `/structured`, discovery) must not accidentally widen — new routes under those mounts inherit their auth posture.
- **Secrets**: no secrets in code, logs, or audit payloads — audit paths go through `redactSecrets`; tokens cached at rest are AES-256-GCM encrypted via `OAUTH_CACHE_KEY` (`packages/core/src/security/at-rest.ts`); raw tokens never enter executor closures (the auth broker supplies headers — keep it that way); nothing reads `.dev.vars` / `.secrets/` into responses.
- **Injection / SSRF**: D1 access uses prepared statements only (no string-built SQL); outbound fetches from tool/peer/MCP paths respect the existing SSRF validation patterns (`packages/core/tests/unit/security_ssrf.test.ts`); user-supplied URLs validated before fetch.
- **Signatures**: Ed25519 policy-bundle verification (`POLICY_BUNDLE_PUBKEY`) and Stripe webhook signature checks stay mandatory in staging/production — dev-only bypasses must be gated on `ENVIRONMENT`.
- **Fail-open vs fail-closed**: enumerate every new default when config/secret is absent. Dev may fall open with a warning; staging/production must fail closed. Watch the known trap: empty `JWT_VERIFIERS` in prod = all traffic anonymous under `default` tenant.
- **Limits/abuse**: new endpoints participate in the rate limiter and `bodyLimit`; long-running work honors `ctx.signal` so wall-clock limits actually cancel.

## Guard tests

`packages/core/tests/unit/security_{ssrf,redact,at_rest,expr,rate_limit}.test.ts`, `packages/core/tests/unit/auth_{jwt,middleware}.test.ts`, `packages/core/tests/integration/cross_tenant.test.ts`. Flag changed security surface with no test delta.

## Output

Severity-ranked findings with `file:line`, each with concrete exploit scenario ("tenant B can read X by ...") and fix. State "no findings" per category you cleared.
