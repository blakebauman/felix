/**
 * Catalog store (Postgres). Backs the built-in `catalog_*` tools. Every query
 * is scoped by tenant_id — the `products` table has a composite (tenant_id, id)
 * primary key, matching the rest of the schema.
 *
 * Search rides the schema's generated `search_tsv` column (weighted
 * title > category > description) with a trigram OR-arm on title for typo'd
 * single-word queries — capabilities the old D1 `LIKE '%q%'` scan couldn't
 * offer. Results rank by ts_rank, then price.
 */

import { getContext } from '@felix/harness/context';
import { getDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';
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
  active: boolean;
  attrs_json: Record<string, unknown>;
  created_at: number;
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
    active: row.active,
    attrs: row.attrs_json ?? {},
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
  const limit = Math.min(Math.max(opts.limit ?? MAX_LIMIT, 1), MAX_LIMIT);
  const sql = getDb(env);
  // Full-text arm: websearch_to_tsquery handles free-form user text safely
  // (quoted phrases, ORs) against the weighted search_tsv; the `%` trigram
  // arm catches close-miss single words (typos) the FTS stemmer won't.
  // No-query searches keep the plain filtered scan ordered by price.
  const rows = opts.query
    ? await sql<ProductRow[]>`
        SELECT * FROM products
          WHERE tenant_id = ${tenantId} AND active
            ${opts.category ? sql`AND category = ${opts.category}` : sql``}
            ${typeof opts.maxPriceCents === 'number' ? sql`AND price_cents <= ${opts.maxPriceCents}` : sql``}
            AND (search_tsv @@ websearch_to_tsquery('english', ${opts.query})
                 OR title % ${opts.query})
          ORDER BY ts_rank(search_tsv, websearch_to_tsquery('english', ${opts.query})) DESC,
                   price_cents ASC
          LIMIT ${limit}
      `
    : await sql<ProductRow[]>`
        SELECT * FROM products
          WHERE tenant_id = ${tenantId} AND active
            ${opts.category ? sql`AND category = ${opts.category}` : sql``}
            ${typeof opts.maxPriceCents === 'number' ? sql`AND price_cents <= ${opts.maxPriceCents}` : sql``}
          ORDER BY price_cents ASC
          LIMIT ${limit}
      `;
  return rows.map(rowToProduct);
}

export async function getProduct(env: Env, tenantId: string, id: string): Promise<Product | null> {
  const sql = getDb(env);
  const rows = await sql<ProductRow[]>`
    SELECT * FROM products WHERE tenant_id = ${tenantId} AND id = ${id} LIMIT 1
  `;
  return rows[0] ? rowToProduct(rows[0]) : null;
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
  const sql = getDb(env);
  // Fetch one extra row to detect a following page.
  const rows = await sql<ProductRow[]>`
    SELECT * FROM products WHERE tenant_id = ${tenantId} AND active
      ORDER BY id LIMIT ${limit + 1} OFFSET ${offset}
  `;
  const all = rows.map(rowToProduct);
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
  if (items.length === 0) return;
  const sql = getDb(env);
  await sql.begin(async (tx) => {
    for (const it of items) {
      await tx`
        UPDATE products SET inventory = GREATEST(0, inventory - ${it.qty})
          WHERE tenant_id = ${tenantId} AND id = ${it.id} AND inventory != -1
      `;
    }
  });
}

/**
 * Backfill embeddings for an existing catalog. Re-embeds every active product
 * (text + image) into the vector store so recommendations and visual search
 * work for catalogs imported before the embedding hook existed. Awaits each
 * embed so the work completes within the request; bounded by `cap`. Returns
 * the count processed. Best-effort per product (failures are swallowed by the
 * embed fns).
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
  const sql = getDb(env);
  const rows = await sql<{ category: string }[]>`
    SELECT DISTINCT category FROM products
      WHERE tenant_id = ${tenantId} AND active AND category != ''
      ORDER BY category
  `;
  return rows.map((r) => r.category);
}

export async function upsertProduct(env: Env, product: Product): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO products (tenant_id, id, title, description, price_cents, currency,
                          image_url, category, inventory, active, attrs_json, created_at)
      VALUES (${product.tenant_id}, ${product.id}, ${product.title}, ${product.description},
              ${product.price_cents}, ${product.currency}, ${product.image_url},
              ${product.category}, ${product.inventory}, ${product.active},
              ${product.attrs as Record<string, unknown>}, ${product.created_at})
      ON CONFLICT (tenant_id, id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        price_cents = excluded.price_cents,
        currency = excluded.currency,
        image_url = excluded.image_url,
        category = excluded.category,
        inventory = excluded.inventory,
        active = excluded.active,
        attrs_json = excluded.attrs_json
  `;

  // Refresh the product's text + image embeddings for similarity/visual search.
  // Best-effort and off the response path (waitUntil): an embed failure never
  // fails the catalog write. Embeddings access the pgvector store directly,
  // so the manifest's `memory.store` is irrelevant.
  const exec = getContext()?.execCtx;
  const embed = Promise.all([
    upsertProductEmbedding(env, product).catch(() => {}),
    upsertProductImageEmbedding(env, product).catch(() => {}),
  ]).then(() => {});
  if (exec) exec.waitUntil(embed);
}
