/**
 * Visual search via caption-then-embed. Product images can't be embedded by the
 * 768-dim BGE text model directly, so we caption each image with a Workers AI
 * vision model and embed the caption — landing it in the SAME `MEMORY_VEC` index
 * as the text/product vectors, isolated by `kind: 'product_image'`. A shopper's
 * uploaded image runs the identical caption→embed→cosine-query path.
 *
 * This keeps visual search on the existing single index (no new binding) at the
 * cost of pixel-level fidelity (similarity is over the caption, not the pixels).
 * CLIP joint-embeddings would be a future upgrade requiring a 512-dim index.
 *
 * Like the text embeddings, these access `env.MEMORY_VEC` / `env.AI` directly and
 * degrade to no-op / empty on any failure — never failing a catalog write.
 */

import type { Env } from '@felix/orchestrator/env';
import { assertSafeOutboundUrlForEnv } from '@felix/orchestrator/security/ssrf';
import type { Product } from '../models';
import { embedText, type SimilarProduct } from '../personalization/embeddings';

const CAPTION_MODEL = '@cf/llava-hf/llava-1.5-7b-hf';
const CAPTION_PROMPT =
  'Describe this product for visual search in one sentence: item type, color, ' +
  'material, style, and any notable visual features.';
export const PRODUCT_IMAGE_KIND = 'product_image';

export function productImageVectorId(tenant: string, id: string): string {
  return `img:${tenant}:${id}`;
}

/** Caption an image with the vision model. Returns '' on failure. */
export async function captionImage(env: Env, bytes: Uint8Array): Promise<string> {
  try {
    const result = (await env.AI.run(
      CAPTION_MODEL as keyof AiModels,
      {
        image: [...bytes],
        prompt: CAPTION_PROMPT,
        max_tokens: 256,
      } as never,
    )) as unknown as { description?: string };
    return (result?.description ?? '').trim();
  } catch (err) {
    console.warn('captionImage failed', err);
    return '';
  }
}

async function fetchImageBytes(
  env: Env,
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  try {
    // `product.image_url` is tenant-managed catalog data — SSRF-guard it (and
    // enforce https) before the worker fetches it, same as every other
    // outbound path. A rejected URL degrades to no-op, like any fetch failure.
    assertSafeOutboundUrlForEnv(url, env);
    const res = await fetch(url, signal ? { signal } : {});
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Caption + embed a product's catalog image into the image-vector space. */
export async function upsertProductImageEmbedding(env: Env, product: Product): Promise<void> {
  try {
    if (!product.active || !product.image_url) return;
    const bytes = await fetchImageBytes(env, product.image_url);
    if (!bytes) return;
    const caption = await captionImage(env, bytes);
    if (!caption) return;
    const values = await embedText(env, caption);
    if (values.length === 0) return;
    await env.MEMORY_VEC.upsert([
      {
        id: productImageVectorId(product.tenant_id, product.id),
        values,
        metadata: {
          tenant: product.tenant_id,
          kind: PRODUCT_IMAGE_KIND,
          product_id: product.id,
          caption,
        },
      },
    ]);
  } catch (err) {
    console.warn('upsertProductImageEmbedding failed', err);
  }
}

/**
 * Find catalog products whose image is visually similar to the uploaded bytes,
 * scoped to tenant + `kind: product_image`. Empty on any failure.
 */
export async function queryByImage(
  env: Env,
  tenant: string,
  bytes: Uint8Array,
  k: number,
): Promise<SimilarProduct[]> {
  try {
    const caption = await captionImage(env, bytes);
    if (!caption) return [];
    const values = await embedText(env, caption);
    if (values.length === 0) return [];
    const matches = await env.MEMORY_VEC.query(values, {
      topK: Math.max(1, k),
      returnMetadata: 'all',
      filter: { tenant, kind: PRODUCT_IMAGE_KIND },
    });
    return (matches.matches ?? []).map((m) => {
      const meta = (m.metadata ?? {}) as Record<string, unknown>;
      return { product_id: String(meta.product_id ?? ''), score: m.score ?? 0 };
    });
  } catch (err) {
    console.warn('queryByImage failed', err);
    return [];
  }
}
