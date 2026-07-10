/**
 * Personalization agent tools. `recommend_products` suggests catalog items by
 * Vectorize similarity, seeded either from an explicit product or from the
 * shopper's recent behavior (views / cart adds) in this thread. Tenant comes
 * from `getContext()`; the seed thread comes from the react-supplied
 * `ctx.threadId`, exactly like the cart tools.
 */

import { getContext } from '@felix/orchestrator/context';
import type { Tool, ToolOutput } from '@felix/orchestrator/tools/types';
import { defineTool } from '@felix/orchestrator/tools/types';
import { z } from 'zod';
import { readCart } from '../cart-session';
import { getProduct } from '../catalog-store';
import {
  attachThreadEventsToCustomer,
  getSessionCustomer,
  linkSessionToCustomer,
  listRecentBehavior,
  upsertCustomer,
} from './customer-store';
import { querySimilarProducts } from './embeddings';
import { rankRecommendations } from './recommend';

const SEED_LIMIT = 5;
const PER_SEED_K = 10;

function requireCtx(): { env: import('@felix/orchestrator/env').Env; tenantId: string } | string {
  const rc = getContext();
  if (!rc) return '[commerce error] no request context';
  return { env: rc.env, tenantId: rc.auth.principal.tenantId };
}

export function recommendProductsTool(): Tool {
  return defineTool({
    name: 'recommend_products',
    description:
      'Recommend products the shopper is likely to want. Seed from a specific ' +
      'product_id, or omit it to personalize from the shopper’s recent activity ' +
      '(viewed / added items) in this conversation. Returns up to `limit` products as JSON.',
    args: z
      .object({
        product_id: z.string().min(1).optional(),
        limit: z.number().int().positive().max(20).optional(),
      })
      .strict(),
    source: 'commerce',
    async handler({ product_id, limit }, ctx): Promise<ToolOutput> {
      const c = requireCtx();
      if (typeof c === 'string') return c;
      const threadId = ctx?.threadId ?? '';
      const max = limit ?? 5;

      // Seeds: explicit product, else recent view/add_to_cart product ids.
      let seeds: string[] = [];
      if (product_id) {
        seeds = [product_id];
      } else if (threadId) {
        const customerId = await getSessionCustomer(c.env, c.tenantId, threadId);
        const recent = await listRecentBehavior(c.env, c.tenantId, {
          threadId,
          customerId: customerId ?? undefined,
          types: ['view', 'add_to_cart'],
          limit: SEED_LIMIT * 2,
        });
        seeds = [...new Set(recent.map((e) => e.product_id).filter(Boolean))].slice(0, SEED_LIMIT);
      }
      if (seeds.length === 0) {
        return JSON.stringify([]);
      }

      const perSeed = await Promise.all(
        seeds.map((id) => querySimilarProducts(c.env, c.tenantId, { productId: id }, PER_SEED_K)),
      );

      // Exclude the seeds themselves and anything already in the cart.
      const cart = threadId ? await readCart(c.env, threadId) : { items: [] };
      const exclude = new Set<string>([...seeds, ...cart.items.map((i) => i.product_id)]);
      const ranked = rankRecommendations(perSeed, { exclude, limit: max * 2 });

      // Hydrate, dropping inactive / out-of-stock, until we reach `max`.
      const out: Array<Record<string, unknown>> = [];
      for (const id of ranked) {
        if (out.length >= max) break;
        const p = await getProduct(c.env, c.tenantId, id);
        if (!p?.active || p.inventory === 0) continue;
        out.push({
          id: p.id,
          title: p.title,
          price_cents: p.price_cents,
          currency: p.currency,
          category: p.category,
          in_stock: p.inventory !== 0,
        });
      }
      return JSON.stringify(out);
    },
  });
}

export function identifyCustomerTool(): Tool {
  return defineTool({
    name: 'identify_customer',
    description:
      'Identify the shopper by email so their activity is remembered across ' +
      'sessions and recommendations / cart-recovery can reach them. Call this once ' +
      'the shopper shares their email (e.g. at sign-in or checkout).',
    args: z.object({ email: z.string().min(3).max(320), name: z.string().optional() }).strict(),
    source: 'commerce',
    async handler({ email, name }, ctx): Promise<ToolOutput> {
      const c = requireCtx();
      if (typeof c === 'string') return c;
      const id = email.trim().toLowerCase();
      const now = Date.now();
      await upsertCustomer(c.env, {
        tenant_id: c.tenantId,
        id,
        email: id,
        external_ref: '',
        attrs: name ? { name } : {},
        created_at: now,
        last_seen_at: now,
      });
      const threadId = ctx?.threadId ?? '';
      if (threadId) {
        await linkSessionToCustomer(c.env, c.tenantId, threadId, id, now);
        await attachThreadEventsToCustomer(c.env, c.tenantId, threadId, id);
      }
      return `Thanks — I'll remember you as ${id}.`;
    },
  });
}

/** All personalization tool factories, registered together in composition.ts. */
export function personalizationToolFactories(): Record<string, () => Tool> {
  return {
    recommend_products: recommendProductsTool,
    identify_customer: identifyCustomerTool,
  };
}
