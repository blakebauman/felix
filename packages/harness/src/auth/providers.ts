/**
 * Outbound OAuth provider registry.
 *
 * Provider configs come from Worker secrets (one JSON blob, parsed once),
 * and successful client-credentials grants are cached in D1
 * (`oauth_token_cache`) keyed by `(provider, tenant, subject)` — the tenant is
 * part of the opaque cache key so two tenants that happen to share a `subject`
 * never read each other's cached token.
 *
 * Manifests reference providers by name in `mcp_servers[*].auth` /
 * `peers[*].auth` as e.g. `"oauth2:stripe"`. The auth header provider
 * threaded into the builder resolves the prefix and looks up the config.
 *
 * Outbound tokens are only attached to hosts that pass the SSRF allow-list
 * check (see `src/security/ssrf.ts`). A manifest pointing a literal bearer
 * at an attacker-controlled URL won't actually get the bearer header.
 */

import type { Env } from '../env';
import { decryptAtRest, encryptAtRest } from '../security/at-rest';
import { assertSafeOutboundUrlForEnv, isOutboundHostAllowed } from '../security/ssrf';

export interface OAuthProviderConfig {
  client_id: string;
  client_secret: string;
  token_url: string;
  scope?: string;
  audience?: string;
}

let providerConfig: Record<string, OAuthProviderConfig> | null = null;

export function setProviderConfig(cfg: Record<string, OAuthProviderConfig>): void {
  providerConfig = cfg;
}

export function getProviderConfig(name: string): OAuthProviderConfig | undefined {
  return providerConfig?.[name];
}

interface TokenRow {
  cache_key: string;
  access_token: string;
  expires_at: number;
  scope: string;
}

/**
 * Cap the cached lifetime regardless of the issuer's `expires_in`. The token
 * is AES-256-GCM encrypted at rest in D1 (see `security/at-rest.ts`); the
 * shorter TTL still bounds the exposure window if a row and the key both leak.
 * 1 hour matches the JWKS TTL for symmetry.
 */
const MAX_CACHED_TOKEN_TTL_MS = 60 * 60 * 1000;

export async function getClientCredentialsToken(
  env: Env,
  provider: string,
  subject: string,
  tenantId: string,
): Promise<string> {
  const cfg = getProviderConfig(provider);
  if (!cfg) throw new Error(`Unknown OAuth provider: ${provider}`);
  // Tenant is part of the key so a shared `subject` across tenants can't
  // collide on a cached row.
  const cacheKey = `${provider}:${tenantId}:${subject}`;
  const now = Date.now();

  const cached = await env.DB.prepare('SELECT * FROM oauth_token_cache WHERE cache_key = ? LIMIT 1')
    .bind(cacheKey)
    .first<TokenRow>();
  if (cached && cached.expires_at > now + 30_000) {
    // Decryption failure (rotated key, tampered row, legacy plaintext that
    // doesn't decode) -> treat as a cache miss and fetch fresh below.
    const plain = await decryptAtRest(env, cached.access_token);
    if (plain != null) return plain;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
  });
  if (cfg.scope) body.set('scope', cfg.scope);
  if (cfg.audience) body.set('audience', cfg.audience);
  // SSRF guard on the operator-configured token endpoint — the one auth-layer
  // outbound path; throws on a private/loopback/non-https target.
  assertSafeOutboundUrlForEnv(cfg.token_url, env);
  const resp = await fetch(cfg.token_url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    // Don't follow redirects: the SSRF guard only validated the initial
    // token_url, so a 3xx to an internal address would bypass it. A redirect
    // surfaces as a non-2xx and is rejected by the `!resp.ok` check below.
    redirect: 'manual',
  });
  if (!resp.ok) {
    // Don't reflect the upstream body — providers sometimes leak debug
    // detail (signed tokens, internal hostnames) in error responses.
    throw new Error(`OAuth token fetch failed for ${provider}: ${resp.status}`);
  }
  const data = (await resp.json()) as { access_token: string; expires_in?: number; scope?: string };
  const requestedTtl = (data.expires_in ?? 3600) * 1000;
  const ttlMs = Math.min(requestedTtl, MAX_CACHED_TOKEN_TTL_MS);
  const expiresAt = now + ttlMs;
  // Encrypt before persisting. Production requires OAUTH_CACHE_KEY to be
  // set; dev falls back to plaintext with a warning (see at-rest.ts).
  const encrypted = await encryptAtRest(env, data.access_token);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_token_cache (cache_key, access_token, expires_at, scope)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(cacheKey, encrypted, expiresAt, data.scope ?? '')
    .run();
  return data.access_token;
}

/** Build an Authorization header value from a manifest-side ref. */
export async function outboundAuthHeader(
  env: Env,
  ref: { auth?: string; url?: string },
  subject: string,
  tenantId: string,
): Promise<string> {
  const spec = ref.auth ?? '';
  if (!spec) return '';

  // Host binding: never emit an Authorization header for a host that
  // doesn't pass the SSRF allow-list. This stops a (compromised, malicious,
  // or accidentally-misconfigured) manifest from forwarding our bearer to
  // an attacker-controlled host.
  if (ref.url && !isOutboundHostAllowed(ref.url, env)) {
    console.warn(`outboundAuthHeader: refusing to attach bearer to disallowed host: ${ref.url}`);
    return '';
  }

  const [scheme, name] = spec.split(':', 2);
  if (scheme === 'bearer' && name) return `Bearer ${name}`;
  if (scheme === 'oauth2' && name) {
    const token = await getClientCredentialsToken(env, name, subject, tenantId);
    return `Bearer ${token}`;
  }
  return '';
}
