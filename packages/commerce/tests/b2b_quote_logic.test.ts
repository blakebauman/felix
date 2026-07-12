/**
 * Quote pricing + net-terms helpers (pure given the catalog reads, which we
 * stub via the shared fake postgres client).
 */

import type { Env } from '@felix/harness/env';
import { describe, expect, it } from 'vitest';
import { makeFakeSql, withFakeDb } from '../../harness/tests/helpers/fake-sql';
import { dueAt, netDays, priceQuote } from '../src/b2b/quote-logic';

const env = { HYPERDRIVE: { connectionString: 'postgresql://fake' } } as unknown as Env;

/**
 * Fake DB that serves a fixed product set for catalog reads and empty results
 * for every other table priceQuote touches (data_sources → native default,
 * accounts → no account, contract_prices → no contract, behavior_events →
 * zero recent purchases, pricing rules → none), matching the old fake-D1
 * behavior of "catalog only".
 */
function sqlWith(
  products: Record<string, { price_cents: number; title: string; currency?: string }>,
) {
  const { sql } = makeFakeSql(({ text, params }) => {
    if (text.includes('FROM products')) {
      // getProduct: SELECT * FROM products WHERE tenant_id = $1 AND id = $2 LIMIT 1
      const id = params[1] as string;
      const p = products[id];
      if (!p) return [];
      return [
        {
          tenant_id: 't',
          id,
          title: p.title,
          description: '',
          price_cents: p.price_cents,
          currency: p.currency ?? 'usd',
          image_url: '',
          category: '',
          inventory: 5,
          active: true,
          attrs_json: {},
          created_at: 1,
        },
      ];
    }
    return [];
  });
  return sql;
}

describe('priceQuote', () => {
  it('prices from the catalog and computes totals', async () => {
    const sql = sqlWith({
      tee: { price_cents: 2500, title: 'Tee' },
      mug: { price_cents: 1200, title: 'Mug' },
    });
    const out = await withFakeDb(env, sql, () =>
      priceQuote(env, 't', 'acct', [
        { product_id: 'tee', qty: 2 },
        { product_id: 'mug', qty: 1 },
      ]),
    );
    expect(out.errors).toHaveLength(0);
    expect(out.subtotal_cents).toBe(2 * 2500 + 1200);
    expect(out.total_cents).toBe(6200);
    expect(out.items[0]!.line_total_cents).toBe(5000);
  });

  it('honours per-line price + discount overrides', async () => {
    const sql = sqlWith({ tee: { price_cents: 2500, title: 'Tee' } });
    const out = await withFakeDb(env, sql, () =>
      priceQuote(env, 't', 'acct', [
        { product_id: 'tee', qty: 10, unit_price_cents: 2000, discount_cents: 1000 },
      ]),
    );
    // 10 * 2000 - 1000
    expect(out.total_cents).toBe(19000);
    expect(out.discount_cents).toBe(1000);
  });

  it('reports unknown products', async () => {
    const sql = sqlWith({});
    const out = await withFakeDb(env, sql, () =>
      priceQuote(env, 't', 'acct', [{ product_id: 'ghost', qty: 1 }]),
    );
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
