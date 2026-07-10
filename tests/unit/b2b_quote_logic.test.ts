/**
 * Quote pricing + net-terms helpers (pure given the catalog reads, which we
 * stub via a fake env.DB).
 */

import { describe, expect, it } from 'vitest';
import { dueAt, netDays, priceQuote } from '../../src/commerce/b2b/quote-logic';
import type { Env } from '../../src/env';

/** Fake D1 that returns a fixed product row for getProduct. */
function envWith(
  products: Record<string, { price_cents: number; title: string; currency?: string }>,
): Env {
  return {
    DB: {
      prepare() {
        return {
          bind(_tenant: string, id: string) {
            return {
              async first() {
                const p = products[id];
                if (!p) return null;
                return {
                  tenant_id: 't',
                  id,
                  title: p.title,
                  description: '',
                  price_cents: p.price_cents,
                  currency: p.currency ?? 'usd',
                  image_url: '',
                  category: '',
                  inventory: 5,
                  active: 1,
                  attrs_json: '{}',
                  created_at: 1,
                };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
}

describe('priceQuote', () => {
  it('prices from the catalog and computes totals', async () => {
    const env = envWith({
      tee: { price_cents: 2500, title: 'Tee' },
      mug: { price_cents: 1200, title: 'Mug' },
    });
    const out = await priceQuote(env, 't', 'acct', [
      { product_id: 'tee', qty: 2 },
      { product_id: 'mug', qty: 1 },
    ]);
    expect(out.errors).toHaveLength(0);
    expect(out.subtotal_cents).toBe(2 * 2500 + 1200);
    expect(out.total_cents).toBe(6200);
    expect(out.items[0]!.line_total_cents).toBe(5000);
  });

  it('honours per-line price + discount overrides', async () => {
    const env = envWith({ tee: { price_cents: 2500, title: 'Tee' } });
    const out = await priceQuote(env, 't', 'acct', [
      { product_id: 'tee', qty: 10, unit_price_cents: 2000, discount_cents: 1000 },
    ]);
    // 10 * 2000 - 1000
    expect(out.total_cents).toBe(19000);
    expect(out.discount_cents).toBe(1000);
  });

  it('reports unknown products', async () => {
    const env = envWith({});
    const out = await priceQuote(env, 't', 'acct', [{ product_id: 'ghost', qty: 1 }]);
    expect(out.errors[0]).toContain('ghost');
  });
});

describe('net terms', () => {
  it('maps payment terms to due windows', () => {
    expect(netDays('prepaid')).toBe(0);
    expect(netDays('net30')).toBe(30);
    expect(dueAt('net30', 0)).toBe(30 * 86_400_000);
    expect(dueAt('prepaid', 1000)).toBe(1000);
  });
});
