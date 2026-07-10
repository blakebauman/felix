/**
 * commercePlugin — Felix Commerce packaged as a FelixPlugin. Everything the
 * commerce layer (src/commerce/, src/entities/, src/geo/) contributes to the
 * harness is assembled here: HTTP routers, tool factories, cron tasks, the
 * `/acp` self-auth mount, storefront/ACP rate-limit keying, and the body-size
 * floor for the visual-search image upload. Core wires it in through
 * `composition.ts:installedPlugins()` and never names commerce elsewhere.
 */

import type { FelixPlugin, FelixRequestContext } from '../plugins/types';
// Type-only side effect: merges the commerce env vars into the core `Env`
// interface while the plugin is installed.
import './env';
import { buildEntitiesRouter } from '../entities/router';
import { parseGeoMonitorOpts, runGeoMonitorTick } from '../geo/monitor-job';
import { buildGeoRouter } from '../geo/router';
import { buildAcpRouter } from './acp/router';
import { buildB2bQuotesRouter } from './b2b/quote-router';
import { buildB2bRouter } from './b2b/router';
import { b2bToolFactories } from './b2b/tools';
import { buildBillingRouter } from './billing/router';
import { buildBrandsRouter } from './brands/router';
import { buildConsentRouter } from './consent/router';
import { commerceRecordConsentTool } from './consent/tool';
import { runAbandonedCartScan } from './personalization/abandoned-cart-job';
import { personalizationToolFactories } from './personalization/tools';
import { buildStorefrontRouter } from './storefront/router';
import { buildWidgetRouter } from './storefront/widget';
import { commerceCheckoutTool } from './stripe-tool';
import { buildStructuredRootRouter, buildStructuredRouter } from './structured/router';
import { commerceToolFactories } from './tools';
import { visualToolFactories } from './visual/tools';
import { buildCommerceRouter } from './webhook';

// First path segment after `/shop/` that denotes a host-resolved action rather
// than a `:storefront` slug (see storefront/router.ts).
const STOREFRONT_HOST_ACTIONS = new Set(['config', 'chat', 'visual-search']);

/**
 * Public, anonymous surfaces run as tenant `default`, so keying the limiter on
 * the principal tenant would lump every brand's storefront traffic (and its
 * LLM spend) into one bucket — one brand could then exhaust the window for all
 * others. Derive a per-brand key for `/shop/*` (by storefront slug, or by Host
 * for the host-resolved routes) and a dedicated bucket for `/acp`, so these
 * anonymous surfaces are isolated from each other and from `default`.
 */
function rateLimitKey(c: FelixRequestContext): string | undefined {
  const path = new URL(c.req.url).pathname;
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

  return undefined;
}

export const commercePlugin: FelixPlugin = {
  name: 'commerce',

  routes(app, opts) {
    app.route('/commerce', buildCommerceRouter());
    app.route('/commerce', buildConsentRouter());
    app.route('/acp', buildAcpRouter());
    app.route('/brands', buildBrandsRouter());
    app.route('/shop', buildStorefrontRouter({ tools: opts.tools }));
    app.route('/widget', buildWidgetRouter());
    app.route('/structured', buildStructuredRouter());
    // Crawler-facing root aliases (/robots.txt, /sitemap.xml,
    // /.well-known/ai-catalog.json), host-resolved to a brand. Mounted at
    // root where answer engines look.
    app.route('/', buildStructuredRootRouter());
    app.route('/entities', buildEntitiesRouter());
    app.route('/b2b', buildB2bRouter());
    app.route('/b2b', buildB2bQuotesRouter());
    app.route('/b2b/billing', buildBillingRouter());
    app.route('/geo', buildGeoRouter());
  },

  registerTools(register) {
    // Catalog tools read the D1 `products` table; cart tools read/write the
    // session-backed cart; `commerce_checkout` creates a Stripe Checkout
    // Session (gate it with a manifest approval rule). The external
    // catalog-MCP path (spec.mcp_servers) remains an alternative source.
    for (const [name, factory] of Object.entries(commerceToolFactories())) {
      register(name, factory);
    }
    register('commerce_checkout', commerceCheckoutTool);
    register('commerce_record_consent', commerceRecordConsentTool);
    // Predictive-personalization tools (recommendations). Read tenant from
    // the RequestContext + seed from session behavior like the commerce tools.
    for (const [name, factory] of Object.entries(personalizationToolFactories())) {
      register(name, factory);
    }
    // Visual search — match an uploaded image against the catalog's image
    // embeddings (caption-then-embed in Vectorize).
    for (const [name, factory] of Object.entries(visualToolFactories())) {
      register(name, factory);
    }
    // B2B procurement tools — quote-to-cash + authority for the procurement
    // multi-agent.
    for (const [name, factory] of Object.entries(b2bToolFactories())) {
      register(name, factory);
    }
  },

  // `/acp` carries its own bearer API key (ACP_API_KEY, constant-time checked
  // in the router) — the JWT middleware must pass it through as anonymous.
  selfAuthenticatingMounts: ['/acp'],

  rateLimitKey,

  // Storefront visual-search image upload (8 MB, see storefront/router.ts)
  // plus form/multipart overhead.
  bodyLimitBytes: 12 * 1024 * 1024,

  cronTasks: [
    {
      name: 'abandoned_cart_scan',
      // Predictive personalization: flag carts with purchase intent but no
      // completed purchase, idle past the threshold. No-op when there are no
      // recent behavior events.
      run: async ({ env }) => {
        await runAbandonedCartScan(env);
      },
    },
    {
      name: 'geo_monitor_tick',
      // GEO/AEO monitoring: replay tracked shopping queries through a
      // generative engine and record where each brand shows up. No-op when no
      // queries are registered or env.AI is absent.
      run: async ({ env, now, execCtx }) => {
        await runGeoMonitorTick(env, parseGeoMonitorOpts(env), now, execCtx);
      },
    },
  ],
};
