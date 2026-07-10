/**
 * Per-tenant rate limit middleware.
 *
 * Backed by the Cloudflare Rate Limiting binding (sliding window). The
 * binding is declared in `wrangler.jsonc` under `unsafe.bindings`; its
 * `simple` block sets the cap (requests per window) and the window length.
 * Here we just decide the *key* — the authenticated principal's tenant id.
 *
 * Anonymous traffic shares the `default` bucket. That keeps a single noisy
 * unauthenticated caller from saturating model spend across all tenants,
 * at the cost of legitimate dev/probe traffic competing in the same window
 * (acceptable since dev typically configures JWT_VERIFIERS empty AND the
 * Rate Limiting binding is absent in unit tests / dev probes).
 *
 * Soft-fail: when `env.TENANT_RATE_LIMIT` is undefined (vitest, miniflare
 * configs without rate-limit support), the middleware passes through. This
 * keeps existing unit/integration tests green without requiring every test
 * env to ship the binding.
 */

import type { Context, Next } from 'hono';
import type { AuthContext } from '../auth/context';
import type { Env } from '../env';
import { recordCounter } from '../observability/metrics';

type AppContext = Context<{ Bindings: Env; Variables: { auth: AuthContext } }>;

const SKIP_EXACT = new Set(['/health', '/docs', '/openapi.json']);
// `/internal/*` is gated by `CONSUMER_SHARED_SECRET`; queue consumers can
// burst during a backlog and shouldn't share a tenant's normal rate
// budget. The secret check is the authn floor for that prefix.
// `/docs/*` serves the rendered prose docs (Scalar UI lives at exact
// `/docs`); both are public reference surfaces exempt from rate limiting.
const SKIP_PREFIX = ['/.well-known/', '/internal/', '/docs/'];

function shouldSkip(path: string): boolean {
  if (SKIP_EXACT.has(path)) return true;
  return SKIP_PREFIX.some((p) => path.startsWith(p));
}

// First path segment after `/shop/` that denotes a host-resolved action rather
// than a `:storefront` slug (see commerce/storefront/router.ts).
const STOREFRONT_HOST_ACTIONS = new Set(['config', 'chat', 'visual-search']);

/**
 * Public, anonymous surfaces run as tenant `default`, so keying the limiter on
 * the principal tenant would lump every brand's storefront traffic (and its
 * LLM spend) into one bucket — one brand could then exhaust the window for all
 * others. Derive a per-brand key for `/shop/*` (by storefront slug, or by Host
 * for the host-resolved routes) and a dedicated bucket for `/acp`, so these
 * anonymous surfaces are isolated from each other and from `default`.
 */
function deriveKey(c: AppContext, path: string): string {
  if (path === '/acp' || path.startsWith('/acp/')) return 'acp';

  if (path.startsWith('/shop/')) {
    const first = path.slice('/shop/'.length).split('/')[0] ?? '';
    if (first && !STOREFRONT_HOST_ACTIONS.has(first)) {
      // `/shop/:storefront/...` — isolate by the (globally-unique) storefront slug.
      return `shop:${first}`;
    }
    // Host-resolved `/shop/config|chat|visual-search` — isolate by Host header.
    return `shop-host:${(c.req.header('host') ?? '').toLowerCase() || 'unknown'}`;
  }

  const auth = c.get('auth');
  // Empty/missing tenant -> `default`. Rate Limiting keys are already
  // namespaced by the binding's `namespace_id`, so a raw tenant id is
  // safe to pass through without further prefixing.
  return auth?.principal?.tenantId || 'default';
}

export function rateLimitMiddleware() {
  return async (c: AppContext, next: Next): Promise<Response | undefined> => {
    const limiter = c.env.TENANT_RATE_LIMIT;
    if (!limiter) {
      await next();
      return undefined;
    }
    const path = new URL(c.req.url).pathname;
    if (shouldSkip(path)) {
      await next();
      return undefined;
    }

    let outcome: { success: boolean };
    try {
      outcome = await limiter.limit({ key: deriveKey(c, path) });
    } catch (err) {
      // Binding misconfigured at the platform level — fail open rather than
      // 503ing every request. The platform error is logged for ops and a
      // counter is emitted so a silently-degraded limiter is alertable.
      console.error('rate-limit binding failed', err);
      recordCounter('orchestrator_rate_limit_binding_error', {});
      await next();
      return undefined;
    }

    if (!outcome.success) {
      return c.json({ error: 'rate_limited', detail: 'per-tenant rate limit exceeded' }, 429, {
        'retry-after': '60',
      });
    }
    await next();
    return undefined;
  };
}
