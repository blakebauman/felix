/**
 * AuthContext + Principal.
 *
 * The middleware verifies an inbound JWT, builds a Principal, and stores the
 * AuthContext on the AsyncLocalStorage so every governance wrapper can read
 * scopes/tenant/subject without threading the request handle.
 *
 * `outboundToken(target)` routes outbound calls through the OAuth provider
 * registry; the provider config is loaded from KV / Worker secrets at
 * startup.
 */

export interface Principal {
  /** Stable subject (sub claim, or service-account id). */
  subject: string;
  /** Tenant id — used as the partition key for every store. */
  tenantId: string;
  /** Granted scopes (OAuth scope or claim). */
  scopes: readonly string[];
  /** Original JWT issuer ("https://cognito-idp.…" / "https://*.cloudflareaccess.com"). */
  issuer: string;
}

export interface AuthContext {
  principal: Principal;
  /** Returns an `Authorization` header value for the given target. */
  outboundToken: (target: { name?: string; auth?: string; url?: string }) => Promise<string>;
}

export const ANONYMOUS: AuthContext = {
  principal: {
    subject: '',
    tenantId: 'default',
    scopes: [],
    issuer: 'anonymous',
  },
  outboundToken: async () => '',
};
