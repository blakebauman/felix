/**
 * Hono middleware: extracts the inbound JWT, verifies it, builds an
 * AuthContext, and runs the rest of the request inside the AsyncLocalStorage
 * context populated with a fresh `LimitState`.
 *
 * Behavior matrix:
 *
 *   no Authorization header        → ANONYMOUS context, route decides
 *   Bearer <invalid|expired token> → 401 immediately (no anonymous fallback)
 *   Bearer <valid token>           → authenticated context
 *
 * Anonymous requests are allowed only when the manifest opts in (the
 * `allow_anonymous` flag). The middleware doesn't know which manifest the
 * request targets, so routes that wrap tenant data should call
 * `requireAuthenticated(c)` or `requireScopes(c, ...)`; route handlers that
 * dispatch a manifest can use `enforceManifestAuth(c, manifest)`.
 */

import type { Context, Next } from 'hono';
import { disposeLimitState, newLimitState, type RequestContext, runWithContext } from '../context';
import type { Env } from '../env';
import type { Manifest } from '../manifests/schema';
import { ANONYMOUS, type AuthContext } from './context';
import { parseVerifiers, verifyJwt } from './jwt';
import { outboundAuthHeader } from './providers';

type AppContext = Context<{ Bindings: Env; Variables: { auth: AuthContext } }>;

// Path prefixes that carry their own `Authorization: Bearer <key>` scheme
// (NOT a JWT) and enforce it inside the router. If we let the JWT verifier see
// their bearer it would reject the non-JWT key as `invalid_token` and 401
// before the router's own constant-time key check runs — so we skip JWT
// verification for these and let them run as ANONYMOUS at the middleware layer.
// `/internal` (x-consumer-secret) and the Stripe webhook (stripe-signature)
// don't use the Authorization header, so they don't need to be listed here.
const SELF_AUTHENTICATING_MOUNTS = ['/acp'];

function usesOwnAuthScheme(path: string): boolean {
  return SELF_AUTHENTICATING_MOUNTS.some((m) => path === m || path.startsWith(`${m}/`));
}

let warnedNoVerifiers = false;

/**
 * Surface a misconfigured deployment loudly: in any non-development
 * environment, an empty `JWT_VERIFIERS` means every request runs anonymously
 * as tenant `default`, collapsing multi-tenant isolation. Bearer tokens still
 * fail closed (401), but anonymous requests proceed silently — so we emit a
 * one-shot structured error per isolate rather than let it pass unnoticed.
 */
function assertVerifiersConfigured(env: Env): void {
  if (warnedNoVerifiers) return;
  if (env.ENVIRONMENT === 'development') return;
  if (parseVerifiers(env).length > 0) return;
  warnedNoVerifiers = true;
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'auth_misconfigured',
      message:
        'JWT_VERIFIERS is empty in a non-development environment; all traffic is anonymous tenant `default`',
      environment: env.ENVIRONMENT,
    }),
  );
}

export function authMiddleware() {
  return async (c: AppContext, next: Next): Promise<Response | undefined> => {
    const env = c.env;
    assertVerifiersConfigured(env);
    const authHeader = c.req.header('authorization') ?? '';
    const path = new URL(c.req.url).pathname;
    let auth: AuthContext = ANONYMOUS;

    if (authHeader.toLowerCase().startsWith('bearer ') && !usesOwnAuthScheme(path)) {
      const token = authHeader.slice(7).trim();
      const verifiers = parseVerifiers(env);
      if (verifiers.length === 0) {
        // No verifiers configured but caller supplied a token. In production
        // this is a misconfiguration; fail closed.
        if (env.ENVIRONMENT !== 'development') {
          return c.json({ error: 'unauthorized', reason: 'no_verifiers_configured' }, 401, {
            'www-authenticate': 'Bearer error="invalid_token"',
          });
        }
        // Dev: token is decorative — fall through to anonymous.
      } else {
        const result = await verifyJwt(env, token, verifiers);
        if (result.ok) {
          const principal = result.principal;
          auth = {
            principal,
            outboundToken: (target) =>
              outboundAuthHeader(env, target, principal.subject, principal.tenantId),
          };
        } else if (result.reason !== 'no_verifier_matched' || env.ENVIRONMENT !== 'development') {
          // A real bearer that we recognised as malformed/expired/wrong-sig, OR
          // a token whose issuer matches no configured verifier in a non-dev
          // environment: refuse rather than silently demoting to anonymous.
          return c.json({ error: 'unauthorized', reason: result.reason }, 401, {
            'www-authenticate': `Bearer error="${result.reason}"`,
          });
        }
        // dev + no_verifier_matched: mismatched iss during local testing — fall
        // through to anonymous so unit tests / local probes still work.
      }
    }

    c.set('auth', auth);
    // c.executionCtx throws when no ExecutionContext is bound (e.g. unit
    // tests that fetch the app directly). Treat the absence as "no
    // execCtx" rather than a failure.
    let execCtx: ExecutionContext | undefined;
    try {
      execCtx = c.executionCtx;
    } catch {
      execCtx = undefined;
    }
    const ctx: RequestContext = {
      env,
      execCtx,
      auth,
      limitState: newLimitState(),
    };
    return runWithContext(ctx, async () => {
      let disposed = false;
      const dispose = () => {
        if (!disposed) {
          disposed = true;
          disposeLimitState(ctx.limitState);
        }
      };
      try {
        await next();
      } catch (err) {
        dispose();
        throw err;
      }
      // Streaming responses (SSE) hand back a Response whose body has NOT been
      // produced yet — the route returns immediately and the ReadableStream's
      // `start` runs afterwards. Disposing here would abort the request-scoped
      // LimitState (and its signal) before the first model call, surfacing as
      // an `on_error: "request ended"` event. Defer disposal until the body
      // finishes streaming; non-streaming responses dispose synchronously.
      const res = c.res;
      const body = res?.body;
      const isStream =
        !!body && (res.headers.get('content-type') ?? '').includes('text/event-stream');
      if (isStream && body) {
        const ts = new TransformStream();
        // pipeTo resolves when the source ends, rejects on client cancel /
        // stream error — dispose in either case.
        void body.pipeTo(ts.writable).then(dispose, dispose);
        c.res = new Response(ts.readable, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      } else {
        dispose();
      }
      return undefined;
    });
  };
}

export function isAnonymous(auth: AuthContext): boolean {
  return auth === ANONYMOUS || auth.principal.issuer === 'anonymous';
}

/** Helper for routes that demand a non-anonymous principal. */
export function requireAuthenticated(c: AppContext): Response | null {
  const auth = c.get('auth');
  if (!auth || isAnonymous(auth)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return null;
}

/**
 * Dev escape hatch: in `ENVIRONMENT=development` with no verifiers configured,
 * anonymous callers are treated as the `default` tenant rather than rejected,
 * so local probes / the chat-ui example don't have to mint JWTs. Production
 * always has `ENVIRONMENT !== 'development'`, so this never fires there.
 */
export function devAnonymousAllowed(env: Env): boolean {
  return env.ENVIRONMENT === 'development' && parseVerifiers(env).length === 0;
}

/**
 * Route helper: demand a non-anonymous principal carrying a specific scope.
 * Used by privileged surfaces (e.g. `/manifests` writes need
 * `manifests:write`) that aren't gated by a manifest's inbound auth.
 *
 * Dev fallthrough: when no verifiers are configured we let the request
 * proceed even when anonymous so local probes and unit tests don't have to
 * mint JWTs. Production always has verifiers wired — the
 * `parseVerifiers(env).length === 0` branch only fires in `ENVIRONMENT
 * === 'development'`.
 */
export function requireScope(c: AppContext, scope: string): Response | null {
  const auth = c.get('auth');
  if (isAnonymous(auth)) {
    if (devAnonymousAllowed(c.env)) return null;
    return c.json({ error: 'unauthorized' }, 401);
  }
  if (!auth.principal.scopes.includes(scope)) {
    return c.json({ error: 'forbidden', missing_scopes: [scope] }, 403);
  }
  return null;
}

/**
 * Check the manifest's inbound auth requirements against the caller. Returns
 * a 401/403 response when the manifest disallows anonymous and the caller is
 * anonymous, or when required scopes are missing.
 */
export function enforceManifestAuth(c: AppContext, manifest: Manifest): Response | null {
  const inbound = manifest.spec.auth.inbound;
  const auth = c.get('auth');
  if (!inbound.allow_anonymous && isAnonymous(auth)) {
    return c.json({ error: 'unauthorized', manifest: manifest.metadata.name }, 401);
  }
  if (inbound.required_scopes.length > 0) {
    const have = new Set(auth.principal.scopes);
    const missing = inbound.required_scopes.filter((s) => !have.has(s));
    if (missing.length > 0) {
      return c.json({ error: 'forbidden', missing_scopes: missing }, 403);
    }
  }
  return null;
}
