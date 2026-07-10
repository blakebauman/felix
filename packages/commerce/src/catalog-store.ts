/**
 * Catalog store (D1). Backs the built-in `catalog_*` tools. Every query is
 * scoped by tenant_id — the `products` table has a composite (tenant_id, id)
 * primary key, matching the rest of the schema.
 */

import { getContext } from '@felix/orchestrator/context';
import type { Env } from '@felix/orchestrator/env';
import { type Product, ProductSchema } from './models';
import { upsertProductEmbedding } from './personalization/embeddings';
import { upsertProductImageEmbedding } from './visual/embeddings';

interface ProductRow {
  tenant_id: string;
  id: string;
  title: string;
  description: string;
  price_cents: number;
  currency: string;
  image_url: string;
  category: string;
  inventory: number;
  active: number;
  attrs_json: string;
  created_at: number;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function rowToProduct(row: ProductRow): Product {
  return ProductSchema.parse({
    tenant_id: row.tenant_id,
    id: row.id,
    title: row.title,
    description: row.description,
    price_cents: row.price_cents,
    currency: row.currency,
    image_url: row.image_url,
    category: row.category,
    inventory: row.inventory,
    active: row.active === 1,
    attrs: safeJson(row.attrs_json),
    created_at: row.created_at,
  });
}

const MAX_LIMIT = 20;

export interface SearchOpts {
  query?: string;
  category?: string;
  maxPriceCents?: number;
  limit?: number;
}

export async function searchProducts(
  env: Env,
  tenantId: string,
  opts: SearchOpts,
): Promise<Product[]> {
  const clauses = ['tenant_id = ?', 'active = 1'];
  const binds: unknown[] = [tenantId];
  if (opts.query) {
    clauses.push('(title LIKE ? OR description LIKE ?)');
    const like = `%${opts.query}%`;
    binds.push(like, like);
  }
  if (opts.category) {
    clauses.push('category = ?');
    binds.push(opts.category);
  }
  if (typeof opts.maxPriceCents === 'number') {
    clauses.push('price_cents <= ?');
    binds.push(opts.maxPriceCents);
  }
  const limit = Math.min(Math.max(opts.limit ?? MAX_LIMIT, 1), MAX_LIMIT);
  const rows = await env.DB.prepare(
    `SELECT * FROM products WHERE ${clauses.join(' AND ')} ORDER BY price_cents ASC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<ProductRow>();
  return (rows.results ?? []).map(rowToProduct);
}

export async function getProduct(env: Env, tenantId: string, id: string): Promise<Product | null> {
  const row = await env.DB.prepare('SELECT * FROM products WHERE tenant_id = ? AND id = ? LIMIT 1')
    .bind(tenantId, id)
    .first<ProductRow>();
  return row ? rowToProduct(row) : null;
}

/**
 * Paginated list of active products for the feed. Unlike `searchProducts`
 * (capped at MAX_LIMIT for an in-conversation result), this pages through the
 * whole catalog by stable `id` order. Returns the page plus `has_more`.
 */
export async function listProductsPage(
  env: Env,
  tenantId: string,
  opts: { limit: number; offset: number },
): Promise<{ products: Product[]; has_more: boolean }> {
  const limit = Math.min(Math.max(opts.limit, 1), 200);
  const offset = Math.max(opts.offset, 0);
  // Fetch one extra row to detect a following page.
  const rows = await env.DB.prepare(
    `SELECT * FROM products WHERE tenant_id = ? AND active = 1 ORDER BY id LIMIT ? OFFSET ?`,
  )
    .bind(tenantId, limit + 1, offset)
    .all<ProductRow>();
  const all = (rows.results ?? []).map(rowToProduct);
  return { products: all.slice(0, limit), has_more: all.length > limit };
}

/**
 * Decrement inventory for purchased items. Products with `inventory = -1`
 * (unlimited) are skipped; finite stock is clamped at 0 (no negative stock).
 * Best-effort post-order bookkeeping — not a hard reservation/lock.
 */
export async function decrementInventory(
  env: Env,
  tenantId: string,
  items: ReadonlyArray<{ id: string; qty: number }>,
): Promise<void> {
  const stmts = items.map((it) =>
    env.DB.prepare(
      `UPDATE products SET inventory = MAX(0, inventory - ?)
         WHERE tenant_id = ? AND id = ? AND inventory != -1`,
    ).bind(it.qty, tenantId, it.id),
  );
  if (stmts.length) await env.DB.batch(stmts);
}

/**
 * Backfill embeddings for an existing catalog. Re-embeds every active product
 * (text + image) into Vectorize so recommendations and visual search work for
 * catalogs imported before the embedding hook existed. Awaits each embed so the
 * work completes within the request; bounded by `cap`. Returns the count
 * processed. Best-effort per product (failures are swallowed by the embed fns).
 */
export async function reindexCatalogEmbeddings(
  env: Env,
  tenantId: string,
  cap = 2000,
): Promise<number> {
  let processed = 0;
  let offset = 0;
  const pageSize = 100;
  while (processed < cap) {
    const { products, has_more } = await listProductsPage(env, tenantId, {
      limit: pageSize,
      offset,
    });
    for (const product of products) {
      await upsertProductEmbedding(env, product);
      await upsertProductImageEmbedding(env, product);
      processed += 1;
      if (processed >= cap) break;
    }
    if (!has_more || products.length === 0) break;
    offset += pageSize;
  }
  return processed;
}

export async function listCategories(env: Env, tenantId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT category FROM products
       WHERE tenant_id = ? AND active = 1 AND category != ''
       ORDER BY category`,
  )
    .bind(tenantId)
    .all<{ category: string }>();
  return (rows.results ?? []).map((r) => r.category);
}

export async function upsertProduct(env: Env, product: Product): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO products (tenant_id, id, title, description, price_cents, currency,
                           image_url, category, inventory, active, attrs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       price_cents = excluded.price_cents,
       currency = excluded.currency,
       image_url = excluded.image_url,
       category = excluded.category,
       inventory = excluded.inventory,
       active = excluded.active,
       attrs_json = excluded.attrs_json`,
  )
    .bind(
      product.tenant_id,
      product.id,
      product.title,
      product.description,
      product.price_cents,
      product.currency,
      product.image_url,
      product.category,
      product.inventory,
      product.active ? 1 : 0,
      JSON.stringify(product.attrs),
      product.created_at,
    )
    .run();

  // Refresh the product's text + image embeddings for similarity/visual search.
  // Best-effort and off the response path (waitUntil): a missing Vectorize index
  // or embed failure never fails the catalog write. Embeddings access
  // `env.MEMORY_VEC` directly, so the manifest's `memory.store` is irrelevant.
  const exec = getContext()?.execCtx;
  const embed = Promise.all([
    upsertProductEmbedding(env, product).catch(() => {}),
    upsertProductImageEmbedding(env, product).catch(() => {}),
  ]).then(() => {});
  if (exec) exec.waitUntil(embed);
}
