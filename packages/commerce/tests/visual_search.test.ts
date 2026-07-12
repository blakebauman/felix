/**
 * Visual search caption→embed→query orchestration (pure-ish, fakes injected).
 */

import type { Env } from '@felix/harness/env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeSql, withFakeDb } from '../../harness/tests/helpers/fake-sql';
import type { Product } from '../src/models';
import {
  captionImage,
  productImageVectorId,
  queryByImage,
  upsertProductImageEmbedding,
} from '../src/visual/embeddings';

interface FakeOpts {
  caption?: string;
  vector?: number[];
  matches?: Array<{ product_id: string; score: number }>;
}

function fakeEnv(opts: FakeOpts) {
  const upserts: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  const { sql } = makeFakeSql((q) => {
    if (q.text.includes('INSERT INTO memory_vectors')) {
      // upsertVector param order: tenant_id, id, kind, manifest_id, embedding, metadata, created_at
      upserts.push({
        id: String(q.params[1]),
        metadata: {
          kind: q.params[2],
          ...(q.params.find(
            (p): p is Record<string, unknown> =>
              typeof p === 'object' && p !== null && !Array.isArray(p),
          ) ?? {}),
        },
      });
      return 1;
    }
    if (q.text.includes('FROM memory_vectors')) {
      return (opts.matches ?? []).map((m) => ({
        id: 'x',
        kind: 'product_image',
        manifest_id: '',
        metadata: { product_id: m.product_id },
        created_at: 0,
        score: m.score,
      }));
    }
    return [];
  });
  const env = {
    AI: {
      run: async (model: string, _input: unknown) => {
        if (String(model).includes('llava')) return { description: opts.caption ?? '' };
        return { data: [opts.vector ?? [0.1, 0.2, 0.3]] };
      },
    },
    HYPERDRIVE: { connectionString: 'postgresql://fake' },
  } as unknown as Env;
  return { env, sql, upserts };
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
    const { env, sql } = fakeEnv({
      caption: 'a red tee',
      matches: [
        { product_id: 'p1', score: 0.9 },
        { product_id: 'p2', score: 0.7 },
      ],
    });
    const out = await withFakeDb(env, sql, () => queryByImage(env, 'acme', new Uint8Array([1]), 5));
    expect(out.map((m) => m.product_id)).toEqual(['p1', 'p2']);
  });

  it('returns [] when the image cannot be captioned', async () => {
    const { env, sql } = fakeEnv({ caption: '', matches: [{ product_id: 'p1', score: 1 }] });
    expect(
      await withFakeDb(env, sql, () => queryByImage(env, 'acme', new Uint8Array([1]), 5)),
    ).toEqual([]);
  });
});

describe('upsertProductImageEmbedding', () => {
  it('fetches, captions, embeds, and upserts under the image-kind vector id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([9, 9, 9]), { status: 200 })),
    );
    const { env, sql, upserts } = fakeEnv({ caption: 'a tee', vector: [0.5, 0.6] });
    await withFakeDb(env, sql, () => upsertProductImageEmbedding(env, product()));
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.id).toBe(productImageVectorId('acme', 'tee-001'));
    expect(upserts[0]?.metadata.kind).toBe('product_image');
  });

  it('skips products without an image', async () => {
    const { env, sql, upserts } = fakeEnv({ caption: 'x' });
    await withFakeDb(env, sql, () => upsertProductImageEmbedding(env, product({ image_url: '' })));
    expect(upserts).toHaveLength(0);
  });
});
