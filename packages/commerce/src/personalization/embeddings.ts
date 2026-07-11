/**
 * Product embeddings in Vectorize. Reuses the single `MEMORY_VEC` index (768-dim
 * BGE) that backs semantic memory + tool retrieval, isolated by a `kind` filter
 * (`product` here; `product_image` for visual search). This is deliberately a
 * DIRECT `env.MEMORY_VEC` access — it does NOT go through `getMemoryStore`, so
 * the orderloop manifest's `memory.store: none` (which only gates the agent-loop
 * episodic memory) is unaffected.
 *
 * All calls degrade to no-op / empty on a missing index or embed failure, so a
 * catalog write never fails because Vectorize is unprovisioned.
 */

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
    if (!product.active) return;
    const values = await embedText(env, productText(product));
    if (values.length === 0) return;
    await env.MEMORY_VEC.upsert([
      {
        id: productVectorId(product.tenant_id, product.id),
        values,
        metadata: {
          tenant: product.tenant_id,
          kind: PRODUCT_KIND,
          product_id: product.id,
          category: product.category,
        },
      },
    ]);
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
 * Returns an empty list on any failure / missing index.
 */
export async function querySimilarProducts(
  env: Env,
  tenant: string,
  seed: { productId?: string; text?: string },
  k: number,
): Promise<SimilarProduct[]> {
  try {
    let values: number[] | undefined;
    if (seed.productId) {
      const got = await env.MEMORY_VEC.getByIds([productVectorId(tenant, seed.productId)]);
      values = got?.[0]?.values as number[] | undefined;
    }
    if (!values && seed.text) values = await embedText(env, seed.text);
    if (!values || values.length === 0) return [];
    const matches = await env.MEMORY_VEC.query(values, {
      topK: Math.max(1, k),
      returnMetadata: 'all',
      filter: { tenant, kind: PRODUCT_KIND },
    });
    return (matches.matches ?? []).map((m) => {
      const meta = (m.metadata ?? {}) as Record<string, unknown>;
      return { product_id: String(meta.product_id ?? ''), score: m.score ?? 0 };
    });
  } catch (err) {
    console.warn('querySimilarProducts failed', err);
    return [];
  }
}
