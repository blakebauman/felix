---
description: "Inbound JWT verification (Cloudflare Access, Cognito), outbound OAuth with at-rest encryption, and RequestContext tenant isolation."
---

# Auth

Inbound JWT verification, outbound OAuth, the `RequestContext`, and the structural defenses that keep tenants isolated.

## Inbound

`src/auth/middleware.ts` wires inbound auth. Behavior:

| Inbound `Authorization` | Result |
|---|---|
| (absent) | Anonymous context. `tenantId = 'default'`, `scopes = []`, `subject = ''`. Route decides via `enforceManifestAuth`. |
| `Bearer <valid jwt>` | Verify against each configured `VerifierConfig`. On success, build a `Principal` and an `AuthContext`. |
| `Bearer <expired>` | 401 with `www-authenticate: Bearer error="expired"`. |
| `Bearer <bad signature or malformed>` | 401 with `www-authenticate: Bearer error="invalid_token"`. |
| `Bearer <iss not matched>` | Falls through to anonymous (lets dev-mode cross-env probes and tests work). |
| `Bearer <token>` with no verifiers configured | 401 `no_verifiers_configured` in non-dev; anonymous in dev. |

A bearer with a real signature failure is **never** silently demoted to anonymous in non-dev.

### Verifiers

`parseVerifiers(env)` in `src/auth/jwt.ts` reads the **single** `JWT_VERIFIERS` env var — there are no provider-specific env vars. It is a comma-separated list of verifiers; each verifier is whitespace-separated fields `<scheme> <issuer> [audience]` (whitespace, not `:`, so issuer URLs parse unambiguously). Malformed or unknown-scheme entries are skipped.

```
JWT_VERIFIERS="access felix.cloudflareaccess.com my-app-aud,
               cognito https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Ab12 my-client-id"
```

Two `scheme` values are supported; the scheme only selects how the JWKS URL is derived:

1. **`access`** — Cloudflare Access. `issuer` is the team host (e.g. `felix.cloudflareaccess.com`):
   - JWKS URL: `https://<issuer>/cdn-cgi/access/certs`
   - Expected `iss`: `https://<issuer>`
   - Audience: the optional third field (the application AUD tag)
2. **`cognito`** — any standard OIDC issuer whose JWKS lives at the standard path. `issuer` is the full issuer URL:
   - JWKS URL: `${issuer}/.well-known/jwks.json`
   - Expected `iss`: `issuer`
   - Audience: the optional third field
   - Must be `https://` outside `development` — a non-HTTPS issuer would fetch the JWKS (and establish trust) over cleartext, so `parseVerifiers` drops it (fail closed). `http://` is allowed only in dev for local testing.

Both use `jose.createRemoteJWKSet` with a 1-hour cache. The verifier loop walks each config in order; a JWT claim mismatch (`iss`/`aud`) is "not this verifier, try next", a real signature/expiry failure is a hard reject. An empty / all-malformed `JWT_VERIFIERS` yields zero verifiers — fail-closed in production, anonymous in dev (see table above).

### Self-issued JWKS

When `env.JWKS_PUBLIC` (a JWKS JSON document) is set, `getJwks` uses `jose.createLocalJWKSet` for any verifier whose JWKS URL ends in `/.well-known/jwks.json`, instead of fetching remotely, and the Worker serves the document itself at `GET /.well-known/jwks.json` (`src/app.ts`). This lets a deployment be its own issuer — a `cognito`-scheme verifier pointing at the deployment's own hostname verifies tokens minted with the matching private key (`scripts/mint-jwt.ts`), with no external IdP. Staging and production use this for scoped control-plane writes.

### Principal derivation

`payloadToPrincipal` (`src/auth/jwt.ts`):

```ts
{
  subject:  payload.sub ?? '',
  scopes:   (payload.scope ?? '').split(/\s+/).filter(Boolean),
  tenantId: payload['custom:tenant_id']
            ?? payload.tenant_id
            ?? <first label of issuer host>
            ?? 'default',
  issuer:   payload.iss ?? '',
}
```

The first-label-of-issuer-host fallback means that if you stand up multiple Cognito user pools per tenant, the tenant id automatically derives from the issuer. If you have a single pool serving multiple tenants, add a `custom:tenant_id` claim.

### enforceManifestAuth

Routes call this with their target manifest (`src/auth/middleware.ts`):

```ts
if (!inbound.allow_anonymous && isAnonymous(auth))   return c.json({ error: 'unauthorized', ... }, 401);
if (inbound.required_scopes.length > 0) {
  const missing = inbound.required_scopes.filter(s => !principalScopes.has(s));
  if (missing.length > 0)                            return c.json({ error: 'forbidden', missing_scopes }, 403);
}
return null;   // allowed
```

- `requireAuthenticated(c)` is a stricter helper that rejects any anonymous principal regardless of manifest.
- `isAnonymous(auth)` returns true when `auth === ANONYMOUS` or `principal.issuer === 'anonymous'`.

### requireScope (control-plane authorization)

`requireScope(c, scope)` (`src/auth/middleware.ts`) is the per-endpoint gate on every management and commerce-management route: anonymous callers get 401; authenticated callers missing the scope get `403 {"error":"forbidden","missing_scopes":[scope]}`. In `ENVIRONMENT=development` with no verifiers configured, the gate falls open so local probes work without minting tokens.

Enforced scopes:

| Scope | Surface |
|---|---|
| `audit:read` | `/audit`, `/audit/metrics` |
| `approvals:read` / `approvals:decide` | `/approvals` reads / `POST /approvals/:id/decide` |
| `plans:read` | `/plans` |
| `jobs:read` / `jobs:write` | `/jobs` |
| `manifests:read` / `manifests:write` | `/manifests` |
| `eval:read` / `eval:write` | `/eval` |
| `consent:read` | `/commerce/consents`, `/commerce/attribution/*` |
| `geo:write` | `/geo` mutations |
| `brands:write` | `/brands` mutations |
| `b2b:write` | `/b2b` mutations (accounts, quotes, pricing, billing config) |
| `entities:write` | `/entities` source config + sync |

### Self-authenticating mounts

`selfAuthenticatingMounts` (contributed by plugins and threaded into `authMiddleware` by `createApp`; currently `['/acp']` from the commerce plugin) tells `authMiddleware` to skip JWT bearer parsing for those path prefixes — the mount enforces its own credential inside the router (constant-time `ACP_API_KEY` compare for ACP). `/internal/*` and `/entities/:type/push` use the `x-consumer-secret` header against `CONSUMER_SHARED_SECRET`; Stripe webhooks verify the Stripe signature. All shared-secret compares go through `src/security/constant-time.ts`.

## RequestContext

`src/context.ts`. Installed by the auth middleware before every route runs, lives in `AsyncLocalStorage`, dies with the request (auth middleware runs `disposeLimitState` in `finally`; cron + queue handlers wrap their bodies in `runWithContext(buildAnonymousContext(env, ctx), …)` + `disposeLimitState` so audit events from inside those paths actually persist instead of falling back to `console.log`).

```ts
interface RequestContext {
  env: Env;
  execCtx?: ExecutionContext;     // undefined in unit tests w/o ExecutionContext
  auth: AuthContext;
  limitState: LimitState;         // toolCalls, peerHops, startedAt, auditCount,
                                  // abortController, wallClockTimerId?,
                                  // tokens: { input, output }
  threadId?: string;
  manifestId?: string;
}
```

Read with `getContext()` (returns undefined outside scope) or `requireContext()` (throws). Tool wrappers read this to find the principal scopes, the limit state, and the env bindings without parameter threading. The pattern code reads `currentSignal()` to forward `limitState.abortController.signal` into model fetches so wall-clock breaches cancel in-flight gateway calls instead of only blocking the next call.

Why AsyncLocalStorage rather than parameter threading: tools are user-extensible and we want governance state hidden from tool authors so they can't accidentally tamper with it. The pattern also keeps tool signatures simple.

## AuthContext

`src/auth/context.ts`:

```ts
interface AuthContext {
  principal: Principal;
  outboundToken: (target: { name?: string; auth?: string; url?: string }) => Promise<string>;
}
```

`outboundToken` resolves an `Authorization` header value for a peer/MCP target. For Cloudflare Access targets, that's a service token; for OAuth-protected targets it's a cached client-credentials access token.

## Outbound OAuth

`src/auth/providers.ts` registers OAuth provider configs (loaded from a Worker secret) and exposes `outboundAuthHeader(env, target, principalSubject)`. `target.auth` is a string like `bearer:<literal>` or `oauth2:<provider>`. Bearer literals are emitted as-is; `oauth2:` triggers a client-credentials grant via `getClientCredentialsToken`.

Tokens are cached in the `oauth_token_cache` D1 table keyed by `(provider:subject)`, encrypted at rest with `OAUTH_CACHE_KEY` (AES-256-GCM, fresh 96-bit IV per ciphertext, base64-encoded `iv || ciphertext_with_tag`; see `src/security/at-rest.ts`). Cached lifetime is capped at 1 hour regardless of the issuer's `expires_in` to bound exposure if a row leaks.

Rotation is graceful — decryption failures are treated as cache misses and a fresh token is fetched. In staging/production, missing `OAUTH_CACHE_KEY` fails closed on encrypt/decrypt. In development it falls back to plaintext with a one-shot warning.

`outboundAuthHeader` also checks the target URL against the SSRF allow-list (`isOutboundHostAllowed`) before attaching a bearer — a misconfigured manifest that points an outbound bearer at an attacker-controlled host gets an empty header back.

Manifests reference providers by name in `mcp_servers[*].auth` / `peers[*].auth`. The non-local executors that talk to those targets — `McpExecutor`, `A2AExecutor`, and `ContainerExecutor` — receive an `authProvider` closure at construction time that calls back into `outboundAuthHeader` when needed. This keeps the raw token out of the executor's closure scope: the executor asks for a header lazily on each call, the provider does the cache lookup + decrypt, and the result is attached to a single outbound fetch. The model loop and tool authors never see the credential — it lives only in the brief gap between header resolution and fetch dispatch.

## Tenant derivation summary

| Source | When used |
|---|---|
| JWT `custom:tenant_id` claim | Primary path for multi-tenant Cognito pools. |
| JWT `tenant_id` claim | Alternative custom claim. |
| First label of `iss` URL hostname | Falls back here for Cloudflare Access (issuer is `https://<team>.cloudflareaccess.com` → tenant = `<team>`). |
| `'default'` | Anonymous traffic and any unparseable issuer. |

## Thread-id smuggling defense

Two routes accept caller-supplied thread suffixes:

- `POST /chat` and `POST /chat/stream` — `body.thread_id`
- `POST /v1/chat/completions` — `x-thread-id` header

Both reject suffixes containing `:` or `#` with HTTP 400 (`src/api/chat.ts`, `src/api/openai-compat.ts`). The server always prefixes `${tenantId}:`, so a malicious suffix that contained `:another-tenant:foo` could otherwise smuggle the prefix away from the authenticated tenant. The two delimiters cover both internal namespaces:

- `${tenant}:thread-suffix` (ConversationDO)
- `${tenant}#task-id` and `${tenant}#approval-id` (A2A, approvals)

A2A `safeTaskId` (`src/a2a/server.ts`) applies the same defense — caller-supplied task ids containing `:` or `#` are replaced with a fresh UUID.

## Rate limiting

`src/security/rate-limit.ts` runs after auth so it can key on `principal.tenantId`. Sliding window cap configured on the `TENANT_RATE_LIMIT` binding in `wrangler.jsonc`. Anonymous traffic shares the `default` bucket. Soft-fails open if `env.TENANT_RATE_LIMIT` is absent (unit tests, dev probes).

Exempt paths:
- `/health`
- `/.well-known/*`
- `/docs`
- `/openapi.json`

## At-rest encryption

`src/security/at-rest.ts` provides `encryptAtRest(env, plaintext)` / `decryptAtRest(env, blob)` for sensitive columns:

```
plaintext --AES-256-GCM--> base64(iv || ciphertext || tag)
```

Used by:
- `oauth_token_cache.access_token` — cached OAuth tokens.

Behavior matrix:

| Env | OAUTH_CACHE_KEY present | Behavior |
|---|---|---|
| development | yes | Encrypted. |
| development | no | Plaintext with one-shot warning. |
| staging/production | yes | Encrypted. |
| staging/production | no | Throws on encrypt/decrypt (fail-closed). |
