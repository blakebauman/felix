/**
 * Carrier rate-shopping seam (pure; env is just a config string).
 */

import { parseCarrierConfig, rateShop } from '@felix/commerce/shipping-carriers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';

function env(carriers?: unknown): Env {
  return { COMMERCE_CARRIERS: carriers ? JSON.stringify(carriers) : undefined } as unknown as Env;
}

const CONFIG = {
  carriers: [
    {
      id: 'ups',
      carrier: 'UPS',
      services: [
        {
          id: 'ground',
          title: 'UPS Ground',
          base_cents: 700,
          per_item_cents: 100,
          min_days: 3,
          max_days: 5,
        },
        { id: 'air', title: 'UPS Air', base_cents: 2000, min_days: 1, max_days: 2 },
      ],
    },
    {
      id: 'usps',
      carrier: 'USPS',
      services: [
        { id: 'priority', title: 'USPS Priority', base_cents: 800, min_days: 2, max_days: 4 },
      ],
    },
  ],
  intl_multiplier: 2,
  domestic_countries: ['US'],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rateShop', () => {
  it('quotes every service cheapest-first with per-item pricing', async () => {
    const opts = await rateShop(env(CONFIG), {
      itemCount: 3,
      subtotalCents: 5000,
      destinationCountry: 'US',
    });
    // ups ground = 700 + 100*3 = 1000; usps priority = 800; ups air = 2000.
    expect(opts.map((o) => o.id)).toEqual(['usps_priority', 'ups_ground', 'ups_air']);
    expect(opts[1]?.amount_cents).toBe(1000);
    expect(opts[1]?.carrier).toBe('UPS');
  });

  it('applies the international multiplier for non-domestic destinations', async () => {
    const opts = await rateShop(env(CONFIG), {
      itemCount: 1,
      subtotalCents: 5000,
      destinationCountry: 'FR',
    });
    const priority = opts.find((o) => o.id === 'usps_priority');
    expect(priority?.amount_cents).toBe(1600); // 800 * 2
  });

  it('returns [] when no carriers are configured (caller keeps static fallback)', async () => {
    expect(await rateShop(env(), { itemCount: 1, subtotalCents: 0 })).toEqual([]);
    expect(parseCarrierConfig(env())).toBeNull();
  });

  it('drops malformed service entries and ignores carriers left empty', () => {
    const cfg = parseCarrierConfig(
      env({ carriers: [{ id: 'x', carrier: 'X', services: [{ id: 'bad' }] }] }),
    );
    expect(cfg).toBeNull();
  });

  it('quotes a live carrier endpoint and prefixes its option ids', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          options: [
            {
              id: 'next_day',
              title: 'FedEx Overnight',
              amount_cents: 2200,
              min_days: 1,
              max_days: 1,
            },
          ],
        }),
      ),
    );
    const opts = await rateShop(
      env({ carriers: [{ id: 'fedex', carrier: 'FedEx', url: 'https://carrier.test/rates' }] }),
      { itemCount: 1, subtotalCents: 5000 },
    );
    expect(opts).toHaveLength(1);
    expect(opts[0]?.id).toBe('fedex_next_day');
    expect(opts[0]?.amount_cents).toBe(2200);
  });

  it('falls back to a live carrier’s static services when the endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const opts = await rateShop(
      env({
        carriers: [
          {
            id: 'fedex',
            carrier: 'FedEx',
            url: 'https://carrier.test/rates',
            services: [
              { id: 'ground', title: 'FedEx Ground', base_cents: 900, min_days: 3, max_days: 5 },
            ],
          },
        ],
      }),
      { itemCount: 1, subtotalCents: 5000 },
    );
    expect(opts.map((o) => o.id)).toEqual(['fedex_ground']);
    expect(opts[0]?.amount_cents).toBe(900);
  });
});
