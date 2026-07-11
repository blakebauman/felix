/**
 * Built-in commerce tools for the Orderloop agent. Catalog tools read the
 * D1 `products` table; cart tools read/write the session-backed cart; the
 * order tool reads the D1 `orders` table. All are tenant-scoped via
 * `getContext()`; cart tools key off the react-supplied `ctx.threadId`.
 *
 * `commerce_checkout` lives in `stripe-tool.ts` (it owns the Stripe call).
 */

import { getContext } from '@felix/harness/context';
import { toolErrorOutput } from '@felix/harness/tools/errors';
import { defineTool, type Tool, type ToolOutput } from '@felix/harness/tools/types';
import { z } from 'zod';
import { addItem, readCart, removeItem, setQty, writeCart } from './cart-session';
import { getProduct, listCategories, searchProducts } from './catalog-store';
import { cartTotalCents } from './models';
import { getOrder } from './order-store';
import {
  countRecentPurchases,
  getSessionCustomer,
  recordBehaviorEvent,
} from './personalization/customer-store';
import type { BehaviorType } from './personalization/models';
import { applyDynamicAdjustments, applyDynamicToCatalog } from './pricing/dynamic';

/** Demand window for velocity-based dynamic pricing. */
const DEMAND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function requireCtx(): { env: import('@felix/harness/env').Env; tenantId: string } | string {
  const rc = getContext();
  if (!rc) return '[commerce error] no request context';
  return { env: rc.env, tenantId: rc.auth.principal.tenantId };
}

/**
 * Fire-and-forget behavior telemetry — seeds recommendations + abandoned-cart
 * detection. Runs off the response path via `execCtx.waitUntil`; never throws
 * into the tool.
 */
function captureBehavior(
  env: import('@felix/harness/env').Env,
  tenantId: string,
  threadId: string,
  type: BehaviorType,
  productId: string,
): void {
  const task = (async () => {
    const customerId = threadId ? await getSessionCustomer(env, tenantId, threadId) : null;
    await recordBehaviorEvent(env, {
      tenant_id: tenantId,
      type,
      thread_id: threadId,
      customer_id: customerId ?? '',
      product_id: productId,
      ts: Date.now(),
    });
  })();
  const exec = getContext()?.execCtx;
  if (exec) exec.waitUntil(task);
  else void task.catch(() => {});
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Effective display/snapshot price for a single product after dynamic rules. */
async function dynamicPriceCents(
  env: import('@felix/harness/env').Env,
  tenantId: string,
  product: { id: string; category: string; price_cents: number },
): Promise<number> {
  const now = Date.now();
  const r = await applyDynamicAdjustments(
    env,
    tenantId,
    { id: product.id, category: product.category },
    product.price_cents,
    {
      nowMs: now,
      recentUnitsSold: await countRecentPurchases(
        env,
        tenantId,
        product.id,
        now - DEMAND_WINDOW_MS,
      ),
    },
  );
  return r.price_cents;
}

export function catalogSearchTool(): Tool {
  return defineTool({
    name: 'catalog_search',
    description:
      'Search the product catalog. Filter by free-text query, category, and/or maximum ' +
      'price (in cents). Returns up to 20 matching products as JSON.',
    args: z
      .object({
        query: z.string().optional(),
        category: z.string().optional(),
        max_price_cents: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(20).optional(),
      })
      .strict(),
    source: 'commerce',
    async handler(args): Promise<ToolOutput> {
      const c = requireCtx();
      if (typeof c === 'string') return c;
      const products = await searchProducts(c.env, c.tenantId, {
        query: args.query,
        category: args.category,
        maxPriceCents: args.max_price_cents,
        limit: args.limit,
      });
      // Apply dynamic pricing to the page (no-op when the tenant has no rules).
      const now = Date.now();
      const dyn = await applyDynamicToCatalog(
        c.env,
        c.tenantId,
        products.map((p) => ({ id: p.id, category: p.category, price_cents: p.price_cents })),
        now,
        (id) => countRecentPurchases(c.env, c.tenantId, id, now - DEMAND_WINDOW_MS),
      );
      return JSON.stringify(
        products.map((p) => ({
          id: p.id,
          title: p.title,
          price_cents: dyn.get(p.id)?.price_cents ?? p.price_cents,
          currency: p.currency,
          category: p.category,
          in_stock: p.inventory !== 0,
        })),
      );
    },
  });
}

export function catalogGetTool(): Tool {
  return defineTool({
    name: 'catalog_get',
    description: 'Get full details for one product by id (SKU). Returns JSON or a not-found note.',
    args: z.object({ product_id: z.string().min(1) }).strict(),
    source: 'commerce',
    async handler({ product_id }, ctx): Promise<ToolOutput> {
      const c = requireCtx();
      if (typeof c === 'string') return c;
      const p = await getProduct(c.env, c.tenantId, product_id);
      if (!p) return `No product found with id '${product_id}'.`;
      captureBehavior(c.env, c.tenantId, ctx?.threadId ?? '', 'view', p.id);
      const price_cents = await dynamicPriceCents(c.env, c.tenantId, p);
      return JSON.stringify({ ...p, price_cents });
    },
  });
}

export function catalogCategoriesTool(): Tool {
  return defineTool({
    name: 'catalog_categories',
    description: 'List the distinct product categories available in the catalog.',
    args: z.object({}).strict(),
    source: 'commerce',
    async handler(): Promise<ToolOutput> {
      const c = requireCtx();
      if (typeof c === 'string') return c;
      const cats = await listCategories(c.env, c.tenantId);
      return JSON.stringify(cats);
    },
  });
}

function cartSummary(
  items: ReadonlyArray<{ product_id: string; title: string; qty: number; price_cents: number }>,
): string {
  if (items.length === 0) return 'Cart is empty.';
  const lines = items
    .map((it) => `- ${it.qty}× ${it.title || it.product_id} @ ${dollars(it.price_cents)}`)
    .join('\n');
  return `${lines}\nTotal: ${dollars(cartTotalCents(items))}`;
}

export function cartViewTool(): Tool {
  return defineTool({
    name: 'cart_view',
    description: 'Show the current shopping cart: items, quantities, and the total.',
    args: z.object({}).strict(),
    source: 'commerce',
    async handler(_args, ctx): Promise<ToolOutput> {
      const c = requireCtx();
      if (typeof c === 'string') return c;
      const cart = await readCart(c.env, ctx?.threadId ?? '');
      return cartSummary(cart.items);
    },
  });
}

export function cartAddTool(): Tool {
  return defineTool({
    name: 'cart_add',
    description:
      'Add a product to the cart by id, snapshotting its current price. Quantity defaults ' +
      'to 1. If the item is already in the cart, the quantity is increased.',
    args: z
      .object({ product_id: z.string().min(1), qty: z.number().int().positive().default(1) })
      .strict(),
    source: 'commerce',
    async handler({ product_id, qty }, ctx): Promise<ToolOutput> {
      const c = requireCtx();
      if (typeof c === 'string') return c;
      const threadId = ctx?.threadId ?? '';
      if (!threadId)
        return toolErrorOutput(
          'invalid_arguments',
          '[commerce error] cart requires a session thread.',
        );
      const product = await getProduct(c.env, c.tenantId, product_id);
      if (!product) return `No product found with id '${product_id}'.`;
      if (product.inventory === 0) return `'${product.title}' is out of stock.`;
      const cart = await readCart(c.env, threadId);
      // Snapshot the dynamic (rule-adjusted) price at add time.
      const price_cents = await dynamicPriceCents(c.env, c.tenantId, product);
      const next = addItem(cart, {
        product_id: product.id,
        title: product.title,
        qty,
        price_cents,
      });
      next.currency = product.currency;
      next.updated_at = product.created_at; // monotonic-ish; exact ms not needed
      await writeCart(c.env, threadId, next);
      captureBehavior(c.env, c.tenantId, threadId, 'add_to_cart', product.id);
      return `Added ${qty}× ${product.title}.\n${cartSummary(next.items)}`;
    },
  });
}

export function cartUpdateTool(): Tool {
  return defineTool({
    name: 'cart_update',
    description: 'Set the quantity of a product already in the cart. A quantity of 0 removes it.',
    args: z.object({ product_id: z.string().min(1), qty: z.number().int().nonnegative() }).strict(),
    source: 'commerce',
    async handler({ product_id, qty }, ctx): Promise<ToolOutput> {
      const c = requireCtx();
      if (typeof c === 'string') return c;
      const threadId = ctx?.threadId ?? '';
      if (!threadId)
        return toolErrorOutput(
          'invalid_arguments',
          '[commerce error] cart requires a session thread.',
        );
      const cart = await readCart(c.env, threadId);
      if (!cart.items.some((i) => i.product_id === product_id))
        return `'${product_id}' is not in the cart.`;
      const next = setQty(cart, product_id, qty);
      await writeCart(c.env, threadId, next);
      return cartSummary(next.items);
    },
  });
}

export function cartRemoveTool(): Tool {
  return defineTool({
    name: 'cart_remove',
    description: 'Remove a product from the cart entirely.',
    args: z.object({ product_id: z.string().min(1) }).strict(),
    source: 'commerce',
    async handler({ product_id }, ctx): Promise<ToolOutput> {
      const c = requireCtx();
      if (typeof c === 'string') return c;
      const threadId = ctx?.threadId ?? '';
      if (!threadId)
        return toolErrorOutput(
          'invalid_arguments',
          '[commerce error] cart requires a session thread.',
        );
      const cart = await readCart(c.env, threadId);
      const next = removeItem(cart, product_id);
      await writeCart(c.env, threadId, next);
      return cartSummary(next.items);
    },
  });
}

export function orderStatusTool(): Tool {
  return defineTool({
    name: 'order_status',
    description: 'Look up the status and contents of an order by its id.',
    args: z.object({ order_id: z.string().min(1) }).strict(),
    source: 'commerce',
    async handler({ order_id }): Promise<ToolOutput> {
      const c = requireCtx();
      if (typeof c === 'string') return c;
      const order = await getOrder(c.env, c.tenantId, order_id);
      if (!order) return `No order found with id '${order_id}'.`;
      return JSON.stringify({
        id: order.id,
        status: order.status,
        total_cents: order.total_cents,
        currency: order.currency,
        items: order.items,
        created_at: order.created_at,
      });
    },
  });
}

/** All commerce tool factories, registered together in composition.ts. */
export function commerceToolFactories(): Record<string, () => Tool> {
  return {
    catalog_search: catalogSearchTool,
    catalog_get: catalogGetTool,
    catalog_categories: catalogCategoriesTool,
    cart_view: cartViewTool,
    cart_add: cartAddTool,
    cart_update: cartUpdateTool,
    cart_remove: cartRemoveTool,
    order_status: orderStatusTool,
  };
}
