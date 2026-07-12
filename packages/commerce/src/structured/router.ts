/**
 * schema.org / JSON-LD structured-data endpoints. Public, anonymous — these are
 * the surface AI crawlers and generative engines fetch to discover a brand's
 * catalog as machine-readable data (distinct from the agent-to-agent ACP feed).
 *
 *   GET /structured/feed.jsonld                       → ItemList (host-resolved)
 *   GET /structured/products/:id.jsonld               → Product  (host-resolved)
 *   GET /structured/sitemap.xml                       → sitemap  (host-resolved)
 *   GET /structured/robots.txt                        → robots   (host-resolved)
 *   GET /structured/:storefront/feed.jsonld           → ItemList (path = brand_tenant)
 *   GET /structured/:storefront/products/:id.jsonld   → Product  (path = brand_tenant)
 *   GET /structured/:storefront/sitemap.xml           → sitemap  (path = brand_tenant)
 *
 * Plus the crawler-facing root aliases (mounted at `/` via `buildStructuredRootRouter`):
 *   GET /robots.txt
 *   GET /sitemap.xml
 *   GET /.well-known/ai-catalog.json
 *
 * The brand is resolved exactly like the storefront: the `:storefront` segment is
 * the brand's data tenant (globally unique), or the `Host` header via the
 * brand_domains map. All responses carry a weak ETag + Cache-Control so crawlers
 * can revalidate cheaply (If-None-Match → 304).
 *
 * Mounted at `/structured` (+ `/`) in `app.ts`.
 */

import { withCachedDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';
import { type Context, Hono } from 'hono';
import type { Brand } from '../brands/models';
import { getBrandByDomain, getBrandByTenant } from '../brands/store';
import { getProduct, listProductsPage } from '../catalog-store';
import type { Product } from '../models';
import { aiCatalog } from './discovery';
import { breadcrumbFor, feedToItemList, productToJsonLd, type StructuredOpts } from './jsonld';
import { robotsTxt } from './robots';
import { productsToSitemapXml } from './sitemap';

const DEFAULT_BASE_URL = 'https://shop.felix.run';
const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=86400';
const SITEMAP_CAP = 5000;

type Ctx = Context<{ Bindings: Env }>;

function hostOf(c: Ctx): string {
  const fromHeader = (c.req.header('host') ?? '').split(':')[0];
  if (fromHeader) return fromHeader;
  try {
    return new URL(c.req.url).hostname;
  } catch {
    return '';
  }
}

/** Origin where these endpoints are actually reachable (the request host). */
function originOf(c: Ctx): string {
  try {
    return new URL(c.req.url).origin;
  } catch {
    const host = hostOf(c);
    return host ? `https://${host}` : DEFAULT_BASE_URL;
  }
}

/** Canonical base for product/offer links (brand override, else request host). */
function baseUrlFor(brand: Brand, host: string): string {
  const cfg = brand.identity.structured_data.canonical_base_url;
  if (cfg) return cfg.replace(/\/+$/, '');
  if (host) return `https://${host}`;
  return DEFAULT_BASE_URL;
}

function optsFor(brand: Brand, host: string): StructuredOpts {
  return { baseUrl: baseUrlFor(brand, host), gtinAttr: brand.identity.structured_data.gtin_attr };
}

/** Resolve the brand for a structured-data request, honoring the enabled flag. */
async function resolveBrand(c: Ctx, storefront?: string): Promise<Brand | null> {
  const brand = storefront
    ? await getBrandByTenant(c.env, storefront)
    : await getBrandByDomain(c.env, c.req.header('host') ?? '');
  if (!brand || brand.status !== 'active') return null;
  if (!brand.identity.structured_data.enabled) return null;
  return brand;
}

/** Page through the whole catalog (bounded) for sitemap/discovery surfaces. */
async function collectProducts(env: Env, tenant: string, cap = SITEMAP_CAP): Promise<Product[]> {
  const all: Product[] = [];
  let offset = 0;
  const pageSize = 200;
  while (all.length < cap) {
    const { products, has_more } = await listProductsPage(env, tenant, { limit: pageSize, offset });
    all.push(...products);
    if (!has_more || products.length === 0) break;
    offset += pageSize;
  }
  return all.slice(0, cap);
}

/** Weak ETag from a SHA-256 prefix of the body. */
async function etagFor(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `W/"${hex}"`;
}

/** Serve a body with ETag + Cache-Control, honoring If-None-Match → 304. */
async function cached(c: Ctx, body: string, contentType: string): Promise<Response> {
  const etag = await etagFor(body);
  if (c.req.header('if-none-match') === etag) {
    return c.body(null, 304, { etag, 'cache-control': CACHE_CONTROL });
  }
  return c.body(body, 200, {
    'content-type': contentType,
    etag,
    'cache-control': CACHE_CONTROL,
  });
}

function ld(c: Ctx, body: unknown): Promise<Response> {
  return cached(c, JSON.stringify(body, null, 2), 'application/ld+json; charset=utf-8');
}

async function serveFeed(c: Ctx, brand: Brand): Promise<Response> {
  const limit = Number.parseInt(c.req.query('limit') ?? '', 10);
  const offset = Number.parseInt(c.req.query('offset') ?? '', 10);
  const { products } = await listProductsPage(c.env, brand.brand_tenant, {
    limit: Number.isFinite(limit) ? limit : 100,
    offset: Number.isFinite(offset) ? offset : 0,
  });
  return ld(c, feedToItemList(products, brand, optsFor(brand, hostOf(c))));
}

async function serveProduct(c: Ctx, brand: Brand, id: string): Promise<Response> {
  const product = await getProduct(c.env, brand.brand_tenant, id);
  if (!product?.active) return c.json({ error: 'not_found' }, 404);
  const opts = optsFor(brand, hostOf(c));
  // Emit Product + BreadcrumbList as a @graph so crawlers get both the offer
  // data and the category trail in one document.
  const { '@context': _p, ...productNode } = productToJsonLd(product, brand, opts);
  const { '@context': _b, ...breadcrumbNode } = breadcrumbFor(product, brand, opts);
  return ld(c, { '@context': 'https://schema.org', '@graph': [productNode, breadcrumbNode] });
}

async function serveSitemap(c: Ctx, brand: Brand): Promise<Response> {
  const products = await collectProducts(c.env, brand.brand_tenant);
  const xml = productsToSitemapXml(products, baseUrlFor(brand, hostOf(c)));
  return cached(c, xml, 'application/xml; charset=utf-8');
}

function serveRobots(c: Ctx, brand: Brand, sitemapUrl: string): Promise<Response> {
  const body = robotsTxt({
    allowAiCrawlers: brand.identity.structured_data.enabled,
    sitemapUrl,
  });
  return cached(c, body, 'text/plain; charset=utf-8');
}

export function buildStructuredRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Every route here is a read-only crawler surface — serve them through the
  // caching-enabled Hyperdrive config (≤60s staleness is fine for feeds).
  app.use('*', async (c, next) => withCachedDb(c.env, next));

  // ---- Path-resolved (:storefront = brand_tenant) ----
  app.get('/:storefront/feed.jsonld', async (c) => {
    const brand = await resolveBrand(c, c.req.param('storefront'));
    if (!brand) return c.json({ error: 'not_found' }, 404);
    return serveFeed(c, brand);
  });
  app.get('/:storefront/products/:id', async (c) => {
    const brand = await resolveBrand(c, c.req.param('storefront'));
    if (!brand) return c.json({ error: 'not_found' }, 404);
    return serveProduct(c, brand, stripExt(c.req.param('id')));
  });
  app.get('/:storefront/sitemap.xml', async (c) => {
    const storefront = c.req.param('storefront');
    const brand = await resolveBrand(c, storefront);
    if (!brand) return c.json({ error: 'not_found' }, 404);
    return serveSitemap(c, brand);
  });
  app.get('/:storefront/robots.txt', async (c) => {
    const storefront = c.req.param('storefront');
    const brand = await resolveBrand(c, storefront);
    if (!brand) return c.json({ error: 'not_found' }, 404);
    return serveRobots(c, brand, `${originOf(c)}/structured/${storefront}/sitemap.xml`);
  });

  // ---- Host-resolved (custom domain / <slug>.shop.felix.run) ----
  app.get('/feed.jsonld', async (c) => {
    const brand = await resolveBrand(c);
    if (!brand) return c.json({ error: 'not_found' }, 404);
    return serveFeed(c, brand);
  });
  app.get('/products/:id', async (c) => {
    const brand = await resolveBrand(c);
    if (!brand) return c.json({ error: 'not_found' }, 404);
    return serveProduct(c, brand, stripExt(c.req.param('id')));
  });
  app.get('/sitemap.xml', async (c) => {
    const brand = await resolveBrand(c);
    if (!brand) return c.json({ error: 'not_found' }, 404);
    return serveSitemap(c, brand);
  });
  app.get('/robots.txt', async (c) => {
    const brand = await resolveBrand(c);
    if (!brand) return c.json({ error: 'not_found' }, 404);
    return serveRobots(c, brand, `${originOf(c)}/structured/sitemap.xml`);
  });

  return app;
}

/**
 * Crawler-facing root aliases. Mounted at `/` so a custom brand domain serves
 * `/robots.txt`, `/sitemap.xml`, and `/.well-known/ai-catalog.json` where
 * answer engines actually look. All host-resolved (no storefront path).
 */
export function buildStructuredRootRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Read-only crawler aliases — same cached-reads policy as /structured.
  app.use('*', async (c, next) => withCachedDb(c.env, next));

  app.get('/robots.txt', async (c) => {
    const brand = await resolveBrand(c);
    if (!brand) return c.json({ error: 'not_found' }, 404);
    return serveRobots(c, brand, `${originOf(c)}/sitemap.xml`);
  });
  app.get('/sitemap.xml', async (c) => {
    const brand = await resolveBrand(c);
    if (!brand) return c.json({ error: 'not_found' }, 404);
    return serveSitemap(c, brand);
  });
  app.get('/.well-known/ai-catalog.json', async (c) => {
    const brand = await resolveBrand(c);
    if (!brand) return c.json({ error: 'not_found' }, 404);
    const origin = originOf(c);
    const body = aiCatalog(
      brand,
      `${origin}/structured/feed.jsonld`,
      `${origin}/sitemap.xml`,
      `${origin}/structured/products`,
    );
    return cached(c, JSON.stringify(body, null, 2), 'application/json; charset=utf-8');
  });

  return app;
}

/** Allow `:id` to carry an optional `.jsonld` extension. */
function stripExt(id: string): string {
  return id.endsWith('.jsonld') ? id.slice(0, -'.jsonld'.length) : id;
}
