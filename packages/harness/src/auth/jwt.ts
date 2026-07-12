/**
 * Pluggable JWT verifier. Verifiers are configured entirely through the
 * `JWT_VERIFIERS` env var (see `parseVerifiers`) — there are no provider-
 * specific env vars. Two JWKS-URL derivation styles are supported:
 *
 *   - `access`  — Cloudflare Access; JWKS at https://<team>/cdn-cgi/access/certs
 *   - `cognito` — any standard OIDC issuer; JWKS at <issuer>/.well-known/jwks.json
 *                 (named for Cognito, but works for any issuer using the
 *                 standard JWKS path, so peers can authenticate without
 *                 re-issuing tokens).
 *
 * Both styles cache the JWKS for 1 hour (jose's `createRemoteJWKSet`).
 */

import {
  createLocalJWKSet,
  createRemoteJWKSet,
  type JWTPayload,
  errors as joseErrors,
  jwtVerify,
} from 'jose';
import type { Env } from '../env';
import { recordCounterDetached } from '../observability/metrics';
import type { Principal } from './context';

const JWKS_TTL_SECONDS = 3600;

// Pin to asymmetric signature algorithms. JWKS keys are asymmetric public keys,
// so this can never widen; it just makes the `alg:none` / HS-confusion classes
// unrepresentable rather than relying on jose's key-type resolution alone.
const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'];

export type VerifyResult =
  | { ok: true; principal: Principal; payload: JWTPayload }
  | { ok: false; reason: 'invalid_token' | 'expired' | 'no_verifier_matched' };

function jwksUrlForCfAccess(team: string): string {
  return `https://${team}/cdn-cgi/access/certs`;
}

function issuerForCfAccess(team: string): string {
  return `https://${team}`;
}

function jwksUrlForCognito(issuer: string): string {
  return `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
}

// Memoize JWKS resolvers at module (per-isolate) scope. `createRemoteJWKSet`
// owns its own fetch cache keyed by the resolver INSTANCE — so a fresh
// instance per request means `cacheMaxAge` never takes effect and every
// inbound JWT triggers a new JWKS fetch (latency + fetch amplification against
// the IdP). Keying the instance by URL fixes that; the local self-issued set
// is memoized by its raw JSON so a rotation still re-parses.
const remoteJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
let localJwksCache: { raw: string; set: ReturnType<typeof createLocalJWKSet> } | undefined;

function getJwks(env: Env, url: string) {
  // Self-issued issuer: when this deployment serves its own JWKS (JWKS_PUBLIC),
  // verify against it locally rather than fetching — a Worker can't reliably
  // fetch its own custom-domain `/.well-known/jwks.json` over HTTP. Only used
  // for self-issuing (JWKS_PUBLIC is unset alongside a real external IdP).
  if (env.JWKS_PUBLIC && url.endsWith('/.well-known/jwks.json')) {
    try {
      if (localJwksCache?.raw !== env.JWKS_PUBLIC) {
        localJwksCache = {
          raw: env.JWKS_PUBLIC,
          set: createLocalJWKSet(JSON.parse(env.JWKS_PUBLIC)),
        };
      }
      return localJwksCache.set;
    } catch {
      /* malformed JWKS_PUBLIC — fall through to remote */
    }
  }
  let set = remoteJwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { cacheMaxAge: JWKS_TTL_SECONDS * 1000 });
    remoteJwksCache.set(url, set);
  }
  return set;
}

/**
 * How a verifier maps a verified token to a tenant id. Configured per-verifier
 * via an optional `tenant=<directive>` field in `JWT_VERIFIERS`.
 *
 *   - `claim`  — trust the `custom:tenant_id`/`tenant_id` claim, else derive
 *                from the issuer host's first label (the legacy default, used
 *                when no `tenant=` field is given). SECURITY: only safe for a
 *                single-tenant issuer or an IdP that mints those claims itself
 *                (NOT user-editable custom attributes).
 *   - `issuer` — always derive the tenant from the issuer host's first label;
 *                ignore any tenant claim.
 *   - `fixed`  — pin every token from this verifier to a fixed tenant id,
 *                ignoring any claim. The safe choice for a shared IdP: a user
 *                can neither assert another tenant via a mutable claim nor
 *                commingle onto a shared issuer label.
 */
export type TenantBinding =
  | { mode: 'claim' }
  | { mode: 'issuer' }
  | { mode: 'fixed'; tenantId: string };

export interface VerifierConfig {
  scheme: 'access' | 'cognito';
  issuer: string;
  audience?: string;
  /** Tenant-resolution binding; omitted ⇒ legacy `claim` behavior. */
  tenant?: TenantBinding;
}

export async function verifyJwt(
  env: Env,
  token: string,
  configs: VerifierConfig[],
): Promise<VerifyResult> {
  let sawIssuerMatch = false;
  let sawExpired = false;
  for (const cfg of configs) {
    const isAccess = cfg.scheme === 'access';
    const jwksUrl = isAccess ? jwksUrlForCfAccess(cfg.issuer) : jwksUrlForCognito(cfg.issuer);
    const issuer = isAccess ? issuerForCfAccess(cfg.issuer) : cfg.issuer;
    try {
      const jwks = await getJwks(env, jwksUrl);
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: cfg.audience,
        algorithms: ALLOWED_ALGORITHMS,
      });
      return { ok: true, principal: payloadToPrincipal(payload, cfg), payload };
    } catch (err) {
      // jose throws a JWTClaimValidationFailed when iss/aud doesn't match —
      // that's "not this verifier", continue. A signature/expiry/malformed
      // failure means a real bearer that we should reject, not silently
      // demote to anonymous.
      if (err instanceof joseErrors.JWTExpired) {
        sawExpired = true;
        continue;
      }
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        // claim mismatch (iss/aud) → wrong verifier for this token; keep trying.
        continue;
      }
      if (
        err instanceof joseErrors.JWSSignatureVerificationFailed ||
        err instanceof joseErrors.JWSInvalid ||
        err instanceof joseErrors.JWTInvalid ||
        err instanceof joseErrors.JWKSNoMatchingKey
      ) {
        sawIssuerMatch = true;
        continue;
      }
      // Unknown error (network, etc.) — treat as invalid to fail closed.
      sawIssuerMatch = true;
    }
  }
  if (sawExpired) return { ok: false, reason: 'expired' };
  if (sawIssuerMatch) return { ok: false, reason: 'invalid_token' };
  return { ok: false, reason: 'no_verifier_matched' };
}

function payloadToPrincipal(payload: JWTPayload, cfg: VerifierConfig): Principal {
  const sub = (payload.sub as string | undefined) ?? '';
  const scopes = ((payload.scope as string | undefined) ?? '').split(/\s+/).filter(Boolean);
  return {
    subject: sub,
    tenantId: resolveTenant(payload, cfg) || 'default',
    scopes,
    issuer: (payload.iss as string | undefined) ?? '',
  };
}

/**
 * Resolve the tenant for a verified token per the verifier's tenant binding.
 *
 * SECURITY: the default binding (`claim`, used when a verifier declares no
 * `tenant=` field) trusts the `custom:tenant_id`/`tenant_id` claim verbatim
 * and falls back to the issuer host's first label. Trusting the claim is only
 * safe when the IdP mints it (NOT a user-editable custom attribute); the
 * issuer-host fallback collapses every claim-less token from a shared IdP onto
 * one label (commingling tenants). A shared, multi-tenant issuer MUST pin
 * `tenant=<id>` per verifier so neither vector applies.
 */
function resolveTenant(payload: JWTPayload, cfg: VerifierConfig): string {
  const binding = cfg.tenant ?? { mode: 'claim' };
  switch (binding.mode) {
    case 'fixed':
      // Issuer maps to exactly this tenant; the token's own claim is ignored.
      return binding.tenantId;
    case 'issuer':
      return deriveTenantFromIssuer(payload.iss);
    default:
      return (
        (payload['custom:tenant_id'] as string | undefined) ??
        (payload.tenant_id as string | undefined) ??
        deriveTenantFromIssuer(payload.iss)
      );
  }
}

function deriveTenantFromIssuer(iss: unknown): string {
  if (typeof iss !== 'string' || !iss) return 'default';
  try {
    return new URL(iss).host.split('.')[0]!;
  } catch {
    return 'default';
  }
}

/**
 * Parse the `JWT_VERIFIERS` env var into a verifier list. The single env var
 * is the only inbound-auth configuration surface — there are no provider-
 * specific vars.
 *
 * Format: comma-separated verifiers; each verifier is whitespace-separated
 * fields `<scheme> <issuer> [audience] [tenant=<directive>]`. Whitespace (not
 * `:`) delimits the fields so issuer URLs — which contain colons — parse
 * unambiguously. The two optional trailing fields are order-independent: the
 * `tenant=` field is recognised by its prefix, and any other trailing field is
 * the audience.
 *
 *   scheme  — `access` (Cloudflare Access) or `cognito` (any standard
 *             OIDC issuer whose JWKS lives at `<issuer>/.well-known/jwks.json`).
 *             Selects how the JWKS URL is derived; see `verifyJwt`.
 *   issuer  — CF Access team host (e.g. `felix.cloudflareaccess.com`) for
 *             `access`, or the full issuer URL for `cognito`.
 *   audience — expected `aud` claim. SECURITY: when omitted, any validly-signed
 *             token from the issuer is accepted regardless of `aud`, so a token
 *             minted for another application on a shared IdP can be replayed
 *             here. It is therefore REQUIRED for `cognito`-scheme verifiers
 *             outside development (a verifier missing it is skipped with a
 *             one-time error) UNLESS the deployment self-issues (`JWKS_PUBLIC`
 *             set), in which case every cognito verifier resolves to this
 *             single-purpose local issuer and `aud` is optional. `access`
 *             keeps it optional (CF Access tokens are team-scoped).
 *   tenant= — optional tenant-resolution binding (see `TenantBinding`):
 *             `tenant=<id>` pins every token from this verifier to a fixed
 *             tenant (ignoring the claim — the safe choice for a shared IdP);
 *             `tenant=issuer` derives from the issuer host label; `tenant=claim`
 *             (the implicit default when the field is absent) trusts the
 *             `custom:tenant_id`/`tenant_id` claim, else derives from the issuer
 *             host. The literals `claim` and `issuer` are reserved directives,
 *             so a fixed tenant literally named `claim`/`issuer` is not
 *             expressible (use a distinct id).
 *
 * Example:
 *   JWT_VERIFIERS="access felix.cloudflareaccess.com my-app-aud,
 *                  cognito https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Ab12 my-client-id tenant=acme"
 *
 * Malformed or unknown-scheme entries are skipped. An empty / all-malformed
 * value yields zero verifiers, which the middleware treats as fail-closed in
 * production (a bearer token with no verifier → 401).
 */
export function parseVerifiers(env: Env): VerifierConfig[] {
  const raw = env.JWT_VERIFIERS?.trim();
  if (!raw) return [];
  const out: VerifierConfig[] = [];
  const dev = env.ENVIRONMENT === 'development';
  // A deployment that serves its own JWKS (JWKS_PUBLIC) verifies every cognito
  // token against that single local key set (see `getJwks`), so its cognito
  // verifiers are single-purpose self-issued — the cross-app replay concern the
  // audience requirement guards against does not apply.
  const selfIssuing = Boolean(env.JWKS_PUBLIC);
  for (const entry of raw.split(',')) {
    const fields = entry.trim().split(/\s+/).filter(Boolean);
    const [scheme, issuer, ...rest] = fields;
    if (!issuer) continue; // need at least scheme + issuer
    if (scheme !== 'access' && scheme !== 'cognito') continue; // unknown scheme — skip

    // Split the optional trailing fields: the `tenant=` field is prefix-keyed,
    // the first remaining field is the audience.
    let audience: string | undefined;
    let tenant: TenantBinding | undefined;
    for (const field of rest) {
      if (field.startsWith('tenant=')) {
        tenant = parseTenantBinding(field.slice('tenant='.length));
      } else if (audience === undefined) {
        audience = field;
      }
    }

    // A `cognito` issuer's JWKS URL is derived verbatim from the issuer, so an
    // `http://` issuer would fetch the key set (and thus establish trust) over
    // cleartext. Reject non-HTTPS cognito issuers outside development —
    // fail-closed (skip the verifier) rather than authenticate over http. CF
    // Access is already https-pinned. A local dev issuer may be http.
    if (scheme === 'cognito' && !dev && !issuer.startsWith('https://')) continue;

    // Require an audience for cognito verifiers outside development so an
    // any-aud token from a shared IdP can't be replayed here. Skip (fail
    // closed) rather than silently accept, with a one-time error. Self-issued
    // deployments are exempt (single-purpose issuer, see `selfIssuing`).
    if (scheme === 'cognito' && !dev && !selfIssuing && !audience) {
      warnMissingAudience(env, issuer);
      continue;
    }

    const cfg: VerifierConfig = { scheme, issuer, audience };
    if (tenant) cfg.tenant = tenant;
    // A verifier with no explicit binding trusts the (potentially mutable)
    // tenant claim / issuer host outside dev — alertable so shared-IdP
    // operators can pin `tenant=<id>`. Self-issued deployments mint their own
    // claims, so they are not flagged.
    if (!dev && !selfIssuing && !tenant) warnImplicitTenant(env, issuer);
    out.push(cfg);
  }
  return out;
}

/** Parse a `tenant=` directive value into a `TenantBinding`. */
function parseTenantBinding(value: string): TenantBinding | undefined {
  const v = value.trim();
  if (!v) return undefined; // `tenant=` with no value — ignore, fall back to default
  if (v === 'claim') return { mode: 'claim' };
  if (v === 'issuer') return { mode: 'issuer' };
  return { mode: 'fixed', tenantId: v };
}

// One-shot per isolate: parseVerifiers runs on every request, so these guard
// against log/metric spam while still surfacing the misconfiguration once.
let warnedMissingAudience = false;
let warnedImplicitTenant = false;

function warnMissingAudience(env: Env, issuer: string): void {
  if (warnedMissingAudience) return;
  warnedMissingAudience = true;
  recordCounterDetached(env, 'orchestrator_auth_misconfigured', {
    reason: 'cognito_missing_audience',
  });
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'jwt_verifier_skipped',
      reason: 'missing_audience',
      message:
        'cognito verifier omits an audience outside development; skipped. Any validly-signed token from the issuer would otherwise be accepted regardless of `aud` (cross-application replay). Set the audience field.',
      issuer,
    }),
  );
}

function warnImplicitTenant(env: Env, issuer: string): void {
  if (warnedImplicitTenant) return;
  warnedImplicitTenant = true;
  recordCounterDetached(env, 'orchestrator_auth_misconfigured', {
    reason: 'implicit_tenant_binding',
  });
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'jwt_verifier_implicit_tenant',
      message:
        'verifier resolves tenant from a (mutable) token claim or the issuer host outside development; for a shared multi-tenant IdP pin `tenant=<id>` per verifier to prevent cross-tenant assertion.',
      issuer,
    }),
  );
}
