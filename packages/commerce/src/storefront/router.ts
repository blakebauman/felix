/**
 * Public storefront serving + routing.
 *
 *   GET  /shop/config                  → brand config (host-resolved)
 *   POST /shop/chat                    → chat with the brand agent (host-resolved)
 *   POST /shop/chat/stream             → SSE (host-resolved)
 *   GET  /shop/:storefront/config      → brand config (path = brand_tenant)
 *   POST /shop/:storefront/chat        → chat (path)
 *   POST /shop/:storefront/chat/stream → SSE (path)
 *
 * A storefront request is anonymous (the shopper has no brand JWT). We resolve
 * the brand from the request — the `:storefront` path segment is the brand's
 * data tenant (globally unique), or the `Host` header via the brand_domains
 * map — then run the brand's `orderloop` agent inside a context scoped to
 * `brand_tenant` (see `runWithBrandContext`) so catalog/cart/checkout hit the
 * brand's data. Threads are namespaced `${brand_tenant}:${suffix}` for
 * per-brand isolation.
 *
 * Mounted at `/shop` in `app.ts`. Public — no JWT, no operator scope.
 */

import { ChatMessageSchema, MAX_MESSAGES } from '@felix/harness/api/openapi-shared';
import { withCachedDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';
import { buildAgent } from '@felix/harness/manifests/builder';
import { type ResolvedManifest, resolveManifest } from '@felix/harness/manifests/resolver';
import type { Agent } from '@felix/harness/patterns/types';
import type { ToolProvider } from '@felix/harness/tools/provider';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { Brand } from '../brands/models';
import { getBrandByDomain, getBrandByTenant } from '../brands/store';
import { queryByImage } from '../visual/embeddings';
import { hydrateMatches } from '../visual/tools';
import { runWithBrandContext } from './context';

const SUFFIX_DELIMS = /[:#]/;
const BRAND_MANIFEST = 'orderloop';

const StorefrontChatRequest = z
  .object({
    messages: z.array(ChatMessageSchema).min(1).max(MAX_MESSAGES),
    thread_id: z.string().optional(),
  })
  .strict();

function publicBrand(brand: Brand) {
  return {
    id: brand.id,
    name: brand.name,
    storefront: brand.brand_tenant,
    identity: brand.identity,
  };
}

type StorefrontCtx = Context<{ Bindings: Env }>;

export function buildStorefrontRouter(deps: { tools: ToolProvider }) {
  const app = new Hono<{ Bindings: Env }>();
  const agentCache = new Map<string, Promise<Agent>>();

  function getAgent(env: Env, resolved: ResolvedManifest): Promise<Agent> {
    let pending = agentCache.get(resolved.cacheKey);
    if (!pending) {
      pending = buildAgent(resolved.manifest, { env, tools: deps.tools });
      agentCache.set(resolved.cacheKey, pending);
    }
    return pending;
  }

  async function resolveByHost(
    c: { req: { header: (k: string) => string | undefined } },
    env: Env,
  ) {
    return getBrandByDomain(env, c.req.header('host') ?? '');
  }

  function threadFor(brand: Brand, suffix: string | undefined): string | undefined {
    if (!suffix || SUFFIX_DELIMS.test(suffix)) return undefined;
    return `${brand.brand_tenant}:${suffix}`;
  }

  async function serveChat(c: StorefrontCtx, brand: Brand) {
    if (brand.status !== 'active') return c.json({ error: 'storefront_unavailable' }, 403);
    const parsed = StorefrontChatRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
    const threadId = threadFor(brand, parsed.data.thread_id);

    let resolved: ResolvedManifest;
    try {
      resolved = await resolveManifest(c.env, brand.brand_tenant, BRAND_MANIFEST, {
        ...(threadId ? { threadId } : {}),
      });
    } catch {
      return c.json({ error: 'storefront_not_provisioned' }, 404);
    }
    const agent = await getAgent(c.env, resolved);
    try {
      const result = await runWithBrandContext(
        c.env,
        c.executionCtx,
        brand.brand_tenant,
        threadId,
        () => agent.invoke({ messages: parsed.data.messages, threadId }),
      );
      return c.json(
        { messages: result.messages, final: result.final, thread_id: parsed.data.thread_id },
        200,
      );
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 500);
      return c.json({ error: 'invocation_failed', detail: message }, 502);
    }
  }

  async function serveStream(c: StorefrontCtx, brand: Brand) {
    if (brand.status !== 'active') return c.json({ error: 'storefront_unavailable' }, 403);
    const parsed = StorefrontChatRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
    const threadId = threadFor(brand, parsed.data.thread_id);

    let resolved: ResolvedManifest;
    try {
      resolved = await resolveManifest(c.env, brand.brand_tenant, BRAND_MANIFEST, {
        ...(threadId ? { threadId } : {}),
      });
    } catch {
      return c.json({ error: 'storefront_not_provisioned' }, 404);
    }
    const agent = await getAgent(c.env, resolved);
    const env = c.env;
    const execCtx = c.executionCtx;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          await runWithBrandContext(env, execCtx, brand.brand_tenant, threadId, async () => {
            for await (const event of agent.streamEvents({
              messages: parsed.data.messages,
              threadId,
            })) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
          });
        } catch (err) {
          const message = String((err as Error)?.message ?? err).slice(0, 500);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ event: 'on_error', data: { message } })}\n\n`),
          );
        } finally {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }

  // Visual search: shopper uploads an image; we caption→embed→cosine-query the
  // brand's catalog image vectors and return matching products. The upload is
  // stashed in R2 for traceability. Anonymous + brand-scoped, like chat.
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  async function serveVisualSearch(c: StorefrontCtx, brand: Brand) {
    if (brand.status !== 'active') return c.json({ error: 'storefront_unavailable' }, 403);
    const form = await c.req.formData().catch(() => null);
    const raw = form?.get('image');
    if (!raw || typeof raw === 'string') return c.json({ error: 'missing_image' }, 400);
    const file = raw as Blob;
    const buf = await file.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) {
      return c.json({ error: 'invalid_image' }, 400);
    }
    const bytes = new Uint8Array(buf);
    const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') ?? '', 10) || 5, 1), 20);

    const key = `visual/${brand.brand_tenant}/${crypto.randomUUID()}`;
    try {
      await c.env.BUNDLES.put(key, buf, {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
      });
    } catch {
      /* R2 stash is best-effort traceability; search proceeds regardless. */
    }

    const matches = await queryByImage(c.env, brand.brand_tenant, bytes, limit * 2);
    const json = await hydrateMatches(c.env, brand.brand_tenant, matches, limit);
    return c.body(json, 200, { 'content-type': 'application/json; charset=utf-8' });
  }

  function configResponse(c: StorefrontCtx, brand: Brand | null) {
    if (!brand) return c.json({ error: 'storefront_not_found' }, 404);
    if (brand.status !== 'active') return c.json({ error: 'storefront_unavailable' }, 403);
    return c.json(publicBrand(brand), 200);
  }

  // ---- Host-resolved routes (custom domain / <slug>.shop.felix.run) ----
  // Config renders are read-only brand/catalog lookups — cached reads OK.
  app.get('/config', async (c) =>
    withCachedDb(c.env, async () => configResponse(c, await resolveByHost(c, c.env))),
  );
  app.post('/chat', async (c) => {
    const brand = await resolveByHost(c, c.env);
    if (!brand) return c.json({ error: 'storefront_not_found' }, 404);
    return serveChat(c, brand);
  });
  app.post('/chat/stream', async (c) => {
    const brand = await resolveByHost(c, c.env);
    if (!brand) return c.json({ error: 'storefront_not_found' }, 404);
    return serveStream(c, brand);
  });
  app.post('/visual-search', async (c) => {
    const brand = await resolveByHost(c, c.env);
    if (!brand) return c.json({ error: 'storefront_not_found' }, 404);
    return serveVisualSearch(c, brand);
  });

  // ---- Path-resolved routes (:storefront = brand_tenant) ----
  app.get('/:storefront/config', async (c) =>
    withCachedDb(c.env, async () =>
      configResponse(c, await getBrandByTenant(c.env, c.req.param('storefront'))),
    ),
  );
  app.post('/:storefront/chat', async (c) => {
    const brand = await getBrandByTenant(c.env, c.req.param('storefront'));
    if (!brand) return c.json({ error: 'storefront_not_found' }, 404);
    return serveChat(c, brand);
  });
  app.post('/:storefront/chat/stream', async (c) => {
    const brand = await getBrandByTenant(c.env, c.req.param('storefront'));
    if (!brand) return c.json({ error: 'storefront_not_found' }, 404);
    return serveStream(c, brand);
  });
  app.post('/:storefront/visual-search', async (c) => {
    const brand = await getBrandByTenant(c.env, c.req.param('storefront'));
    if (!brand) return c.json({ error: 'storefront_not_found' }, 404);
    return serveVisualSearch(c, brand);
  });

  return app;
}
