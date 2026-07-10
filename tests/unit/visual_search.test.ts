/**
 * Visual search caption→embed→query orchestration (pure-ish, fakes injected).
 */

import type { Product } from '@felix/commerce/models';
import {
  captionImage,
  productImageVectorId,
  queryByImage,
  upsertProductImageEmbedding,
} from '@felix/commerce/visual/embeddings';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';

interface FakeOpts {
  caption?: string;
  vector?: number[];
  matches?: Array<{ product_id: string; score: number }>;
}

function fakeEnv(opts: FakeOpts) {
  const upserts: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  const env = {
    AI: {
      run: async (model: string, _input: unknown) => {
        if (String(model).includes('llava')) return { description: opts.caption ?? '' };
        return { data: [opts.vector ?? [0.1, 0.2, 0.3]] };
      },
    },
    MEMORY_VEC: {
      upsert: async (recs: Array<{ id: string; metadata: Record<string, unknown> }>) => {
        upserts.push(...recs);
      },
      query: async () => ({
        matches: (opts.matches ?? []).map((m) => ({
          id: 'x',
          score: m.score,
          metadata: { product_id: m.product_id },
        })),
      }),
      getByIds: async () => [],
    },
  } as unknown as Env;
  return { env, upserts };
}

function product(over: Partial<Product> = {}): Product {
  return {
    tenant_id: 'acme',
    id: 'tee-001',
    title: 'Tee',
    description: '',
    price_cents: 1000,
    currency: 'usd',
    image_url: 'https://cdn.test/tee.png',
    category: 'apparel',
    inventory: 5,
    active: true,
    attrs: {},
    created_at: 1,
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('captionImage', () => {
  it('returns the vision model description', async () => {
    const { env } = fakeEnv({ caption: 'a red cotton tee' });
    expect(await captionImage(env, new Uint8Array([1, 2, 3]))).toBe('a red cotton tee');
  });
});

describe('queryByImage', () => {
  it('captions, embeds, and maps matches to product ids', async () => {
    const { env } = fakeEnv({
      caption: 'a red tee',
      matches: [
        { product_id: 'p1', score: 0.9 },
        { product_id: 'p2', score: 0.7 },
      ],
    });
    const out = await queryByImage(env, 'acme', new Uint8Array([1]), 5);
    expect(out.map((m) => m.product_id)).toEqual(['p1', 'p2']);
  });

  it('returns [] when the image cannot be captioned', async () => {
    const { env } = fakeEnv({ caption: '', matches: [{ product_id: 'p1', score: 1 }] });
    expect(await queryByImage(env, 'acme', new Uint8Array([1]), 5)).toEqual([]);
  });
});

describe('upsertProductImageEmbedding', () => {
  it('fetches, captions, embeds, and upserts under the image-kind vector id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([9, 9, 9]), { status: 200 })),
    );
    const { env, upserts } = fakeEnv({ caption: 'a tee', vector: [0.5, 0.6] });
    await upsertProductImageEmbedding(env, product());
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.id).toBe(productImageVectorId('acme', 'tee-001'));
    expect(upserts[0]?.metadata.kind).toBe('product_image');
  });

  it('skips products without an image', async () => {
    const { env, upserts } = fakeEnv({ caption: 'x' });
    await upsertProductImageEmbedding(env, product({ image_url: '' }));
    expect(upserts).toHaveLength(0);
  });
});
