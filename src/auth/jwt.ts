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

async function getJwks(env: Env, url: string) {
  // Self-issued issuer: when this deployment serves its own JWKS (JWKS_PUBLIC),
  // verify against it locally rather than fetching — a Worker can't reliably
  // fetch its own custom-domain `/.well-known/jwks.json` over HTTP. Only used
  // for self-issuing (JWKS_PUBLIC is unset alongside a real external IdP).
  if (env.JWKS_PUBLIC && url.endsWith('/.well-known/jwks.json')) {
    try {
      return createLocalJWKSet(JSON.parse(env.JWKS_PUBLIC));
    } catch {
      /* malformed JWKS_PUBLIC — fall through to remote */
    }
  }
  // jose's createRemoteJWKSet handles its own caching; we pin the URL and
  // let it manage fetches. KV caching is a future refinement.
  return createRemoteJWKSet(new URL(url), { cacheMaxAge: JWKS_TTL_SECONDS * 1000 });
}

export interface VerifierConfig {
  scheme: 'access' | 'cognito';
  issuer: string;
  audience?: string;
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
      return { ok: true, principal: payloadToPrincipal(payload), payload };
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

function payloadToPrincipal(payload: JWTPayload): Principal {
  const sub = (payload.sub as string | undefined) ?? '';
  const scopes = ((payload.scope as string | undefined) ?? '').split(/\s+/).filter(Boolean);
  // Tenant id: prefer an explicit, IdP-asserted claim, else fall back to the
  // issuer host's first label. SECURITY: `custom:tenant_id`/`tenant_id` are
  // trusted verbatim, so they MUST be IdP-asserted and NOT user-editable custom
  // attributes — otherwise a user could mint a token for another tenant. The
  // issuer-host fallback is a convenience for single-tenant issuers; for a
  // shared IdP pool it collapses every claim-less token onto one label
  // (commingling tenants), so multi-tenant deployments should always assert an
  // explicit tenant claim.
  const tenantId =
    (payload['custom:tenant_id'] as string | undefined) ??
    (payload.tenant_id as string | undefined) ??
    deriveTenantFromIssuer(payload.iss);
  return {
    subject: sub,
    tenantId: tenantId || 'default',
    scopes,
    issuer: (payload.iss as string | undefined) ?? '',
  };
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
 * fields `<scheme> <issuer> [audience]`. Whitespace (not `:`) delimits the
 * fields so issuer URLs — which contain colons — parse unambiguously.
 *
 *   scheme  — `access` (Cloudflare Access) or `cognito` (any standard
 *             OIDC issuer whose JWKS lives at `<issuer>/.well-known/jwks.json`).
 *             Selects how the JWKS URL is derived; see `verifyJwt`.
 *   issuer  — CF Access team host (e.g. `felix.cloudflareaccess.com`) for
 *             `access`, or the full issuer URL for `cognito`.
 *   audience — optional expected `aud` claim. SECURITY: when omitted, any
 *             validly-signed token from the issuer is accepted regardless of
 *             `aud`. Set it whenever the issuer is a shared IdP serving more
 *             than one application, so a token minted for another app can't be
 *             replayed here. (A single-purpose self-issued issuer can safely
 *             omit it.)
 *
 * Example:
 *   JWT_VERIFIERS="access felix.cloudflareaccess.com my-app-aud,
 *                  cognito https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Ab12 my-client-id"
 *
 * Malformed or unknown-scheme entries are skipped. An empty / all-malformed
 * value yields zero verifiers, which the middleware treats as fail-closed in
 * production (a bearer token with no verifier → 401).
 */
export function parseVerifiers(env: Env): VerifierConfig[] {
  const raw = env.JWT_VERIFIERS?.trim();
  if (!raw) return [];
  const out: VerifierConfig[] = [];
  for (const entry of raw.split(',')) {
    const [scheme, issuer, audience] = entry.trim().split(/\s+/).filter(Boolean);
    if (!issuer) continue; // need at least scheme + issuer
    if (scheme !== 'access' && scheme !== 'cognito') continue; // unknown scheme — skip
    out.push({ scheme, issuer, audience });
  }
  return out;
}
