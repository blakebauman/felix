/**
 * Product embeddings in pgvector. Reuses the single `memory_vectors` table
 * (768-dim BGE) that backs semantic + procedural memory, isolated by the
 * `kind` column (`product` here; `product_image` for visual search). This is
 * deliberately a DIRECT vector-store access — it does NOT go through
 * `getMemoryStore`, so the orderloop manifest's `memory.store: none` (which
 * only gates the agent-loop episodic memory) is unaffected.
 *
 * All calls degrade to no-op / empty on a missing binding or embed failure,
 * so a catalog write never fails because the database is unprovisioned.
 */

import { getVectorValues, queryVectors, upsertVector } from '@felix/harness/db/vectors';
import type { Env } from '@felix/harness/env';
import type { Product } from '../models';

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
export const PRODUCT_KIND = 'product';

/** Vector id for a product's text embedding. */
export function productVectorId(tenant: string, id: string): string {
  return `prod:${tenant}:${id}`;
}

/** The text we embed for catalog similarity. */
export function productText(p: Product): string {
  const brand = typeof p.attrs.brand === 'string' ? p.attrs.brand : '';
  return [p.title, p.category, brand, p.description].filter(Boolean).join(' ');
}

export async function embedText(env: Env, text: string): Promise<number[]> {
  const result = (await env.AI.run(
    EMBED_MODEL as keyof AiModels,
    { text } as never,
  )) as unknown as {
    data: number[][];
  };
  return result.data?.[0] ?? [];
}

/** Upsert (or refresh) a product's text embedding. Best-effort. */
export async function upsertProductEmbedding(env: Env, product: Product): Promise<void> {
  try {
    if (!product.active || !env.HYPERDRIVE) return;
    const values = await embedText(env, productText(product));
    if (values.length === 0) return;
    await upsertVector(env, {
      tenantId: product.tenant_id,
      id: productVectorId(product.tenant_id, product.id),
      kind: PRODUCT_KIND,
      values,
      metadata: { product_id: product.id, category: product.category },
    });
  } catch (err) {
    console.warn('upsertProductEmbedding failed', err);
  }
}

export interface SimilarProduct {
  product_id: string;
  score: number;
}

/**
 * Top-k catalog products similar to a seed, scoped to tenant + `kind: product`.
 * The seed is an existing product (its stored vector is reused) or free text.
 * Returns an empty list on any failure / missing binding.
 */
export async function querySimilarProducts(
  env: Env,
  tenant: string,
  seed: { productId?: string; text?: string },
  k: number,
): Promise<SimilarProduct[]> {
  try {
    if (!env.HYPERDRIVE) return [];
    let values: number[] | undefined;
    if (seed.productId) {
      values =
        (await getVectorValues(env, tenant, productVectorId(tenant, seed.productId))) ?? undefined;
    }
    if (!values && seed.text) values = await embedText(env, seed.text);
    if (!values || values.length === 0) return [];
    const matches = await queryVectors(env, {
      tenantId: tenant,
      kinds: [PRODUCT_KIND],
      values,
      topK: Math.max(1, k),
    });
    return matches.map((m) => ({
      product_id: String(m.metadata.product_id ?? ''),
      score: m.score,
    }));
  } catch (err) {
    console.warn('querySimilarProducts failed', err);
    return [];
  }
}
