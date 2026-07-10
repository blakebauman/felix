/**
 * Tax + shipping seams (pure given env config).
 */

import { describe, expect, it } from 'vitest';
import { parseShippingConfig, shippingOptions } from '../../src/commerce/shipping';
import { computeTax, parseTaxBps } from '../../src/commerce/tax';
import type { Env } from '../../src/env';

function env(over: Partial<Env> = {}): Env {
  return over as Env;
}

describe('tax seam', () => {
  it('defaults to 0 when unset', () => {
    expect(parseTaxBps(env())).toBe(0);
    expect(computeTax(env(), { subtotalCents: 10000, shippingCents: 500 })).toBe(0);
  });

  it('applies a flat basis-point rate to subtotal + shipping', () => {
    const e = env({ COMMERCE_TAX_BPS: '875' }); // 8.75%
    // (10000 + 500) * 8.75% = 918.75 -> rounds to 919
    expect(computeTax(e, { subtotalCents: 10000, shippingCents: 500 })).toBe(919);
  });

  it('ignores invalid config and clamps absurd rates', () => {
    expect(parseTaxBps(env({ COMMERCE_TAX_BPS: 'nope' }))).toBe(0);
    expect(parseTaxBps(env({ COMMERCE_TAX_BPS: '999999' }))).toBe(10_000);
  });
});

describe('shipping seam', () => {
  it('falls back to defaults when unset or invalid', () => {
    expect(parseShippingConfig(env()).options.map((o) => o.id)).toEqual(['standard', 'express']);
    expect(parseShippingConfig(env({ COMMERCE_SHIPPING: '{bad' })).options).toHaveLength(2);
  });

  it('returns options sorted cheapest first', async () => {
    const opts = await shippingOptions(env(), { subtotalCents: 1000 });
    expect(opts[0]!.id).toBe('standard');
    expect(opts[0]!.amount_cents).toBe(500);
  });

  it('zeroes the cheapest option past the free-shipping threshold', async () => {
    const e = env({
      COMMERCE_SHIPPING: JSON.stringify({
        free_threshold_cents: 7500,
        options: [
          {
            id: 'standard',
            title: 'Standard',
            subtitle: '5-7',
            carrier: 'USPS',
            amount_cents: 500,
            min_days: 5,
            max_days: 7,
          },
          {
            id: 'express',
            title: 'Express',
            subtitle: '2-3',
            carrier: 'UPS',
            amount_cents: 1500,
            min_days: 2,
            max_days: 3,
          },
        ],
      }),
    });
    expect((await shippingOptions(e, { subtotalCents: 5000 }))[0]!.amount_cents).toBe(500); // below threshold
    const free = await shippingOptions(e, { subtotalCents: 8000 });
    expect(free[0]!.amount_cents).toBe(0); // standard now free
    expect(free[0]!.subtitle).toContain('Free');
    expect(free[1]!.amount_cents).toBe(1500); // express unchanged
  });
});
