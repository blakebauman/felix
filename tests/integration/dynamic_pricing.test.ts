/**
 * Dynamic pricing against real D1: pricing rules (velocity / competitor / time
 * with clamps) layered on the catalog branch of resolveEffectivePrice, and the
 * guarantee that contract tiers still win over any dynamic adjustment.
 */

import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveEffectivePrice } from '../../src/commerce/b2b/pricing';
import { upsertContractPrice } from '../../src/commerce/b2b/pricing-store';
import { priceQuote } from '../../src/commerce/b2b/quote-logic';
import { upsertProduct } from '../../src/commerce/catalog-store';
import type { Product } from '../../src/commerce/models';
import { recordBehaviorEvent } from '../../src/commerce/personalization/customer-store';
import { competitorPriceStore } from '../../src/commerce/pricing/competitor-store';
import { upsertPricingRule } from '../../src/commerce/pricing/rules-store';
import { catalogGetTool } from '../../src/commerce/tools';
import { buildAnonymousContext, runWithContext } from '../../src/context';
import type { Env as AppEnv } from '../../src/env';
import { applyMigrations } from './setup';

function product(tenant: string, id: string, cents: number, category = 'apparel'): Product {
  return {
    tenant_id: tenant,
    id,
    title: id,
    description: '',
    price_cents: cents,
    currency: 'usd',
    image_url: '',
    category,
    inventory: 50,
    active: true,
    attrs: {},
    created_at: 1,
  };
}

const testEnv = env as unknown as AppEnv;
const NOON = Date.UTC(2026, 0, 1, 12, 0, 0); // 12:00 UTC

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
});

describe('dynamic pricing on the catalog branch', () => {
  it('applies a velocity discount only when demand clears the threshold', async () => {
    await upsertPricingRule(testEnv, {
      tenant_id: 'dp',
      id: 'velo',
      scope: 'catalog',
      target: '',
      kind: 'velocity',
      adjustment_bps: -1000, // 10% off
      config: { velocity_threshold: 5, floor_cents: 5000 },
      active: true,
      created_at: 1,
    });

    const hot = await resolveEffectivePrice(testEnv, 'dp', 'acct', 'sku-1', 1, 10_000, null, {
      category: 'apparel',
      signals: { nowMs: NOON, recentUnitsSold: 9 },
    });
    expect(hot.source).toBe('dynamic');
    expect(hot.unit_price_cents).toBe(9000);

    const cold = await resolveEffectivePrice(testEnv, 'dp', 'acct', 'sku-1', 1, 10_000, null, {
      category: 'apparel',
      signals: { nowMs: NOON, recentUnitsSold: 0 },
    });
    expect(cold.source).toBe('catalog');
    expect(cold.unit_price_cents).toBe(10_000);
  });

  it('honors the floor clamp so discounts cannot run away', async () => {
    await upsertPricingRule(testEnv, {
      tenant_id: 'dp2',
      id: 'deep',
      scope: 'catalog',
      target: '',
      kind: 'velocity',
      adjustment_bps: -9000, // would be 90% off
      config: { velocity_threshold: 1, floor_cents: 8000 },
      active: true,
      created_at: 1,
    });
    const res = await resolveEffectivePrice(testEnv, 'dp2', 'acct', 'sku-1', 1, 10_000, null, {
      category: 'apparel',
      signals: { nowMs: NOON, recentUnitsSold: 5 },
    });
    expect(res.unit_price_cents).toBe(8000); // clamped to floor, not 1000
  });

  it('applies a competitor rule when a lower competitor price is on file', async () => {
    await competitorPriceStore.upsert(testEnv, 'dp3', {
      tenant_id: 'dp3',
      id: 'sku-1:rival',
      product_id: 'sku-1',
      source: 'rival',
      price_cents: 8500,
      currency: 'usd',
      observed_at: 1,
    });
    await upsertPricingRule(testEnv, {
      tenant_id: 'dp3',
      id: 'match',
      scope: 'product',
      target: 'sku-1',
      kind: 'competitor',
      adjustment_bps: -500,
      config: {},
      active: true,
      created_at: 1,
    });
    const res = await resolveEffectivePrice(testEnv, 'dp3', 'acct', 'sku-1', 1, 10_000, null, {
      category: 'apparel',
      signals: { nowMs: NOON },
    });
    expect(res.source).toBe('dynamic');
    expect(res.unit_price_cents).toBe(9500);
  });

  it('leaves price unchanged with no dynamic opts (back-compat)', async () => {
    const res = await resolveEffectivePrice(testEnv, 'dp', 'acct', 'sku-1', 1, 10_000, null);
    expect(res.source).toBe('catalog');
    expect(res.unit_price_cents).toBe(10_000);
  });

  it('flows through priceQuote — a velocity rule reprices when recent demand is high', async () => {
    await upsertProduct(testEnv, product('dpq', 'widget', 10_000));
    await upsertPricingRule(testEnv, {
      tenant_id: 'dpq',
      id: 'velo',
      scope: 'catalog',
      target: '',
      kind: 'velocity',
      adjustment_bps: 1000, // +10% surge under demand
      config: { velocity_threshold: 3 },
      active: true,
      created_at: 1,
    });
    // 4 recent purchases of the product → clears the velocity threshold.
    for (let i = 0; i < 4; i += 1) {
      await recordBehaviorEvent(testEnv, {
        tenant_id: 'dpq',
        type: 'purchase',
        product_id: 'widget',
        ts: Date.now(),
      });
    }
    const priced = await priceQuote(testEnv, 'dpq', 'acct', [{ product_id: 'widget', qty: 1 }]);
    expect(priced.items[0]?.unit_price_cents).toBe(11_000);
  });

  it('applies at D2C display time via catalog_get', async () => {
    // Anonymous storefront context → tenant 'default'.
    await upsertProduct(testEnv, product('default', 'd2c-widget', 10_000));
    await upsertPricingRule(testEnv, {
      tenant_id: 'default',
      id: 'always-off',
      scope: 'product',
      target: 'd2c-widget',
      kind: 'time', // no hour window → always applies
      adjustment_bps: -1500,
      config: {},
      active: true,
      created_at: 1,
    });
    const out = await runWithContext(buildAnonymousContext(testEnv), () =>
      catalogGetTool().executor.execute({ product_id: 'd2c-widget' }, { threadId: 'default:t' }),
    );
    const json = JSON.parse(typeof out === 'string' ? out : out.content) as { price_cents: number };
    expect(json.price_cents).toBe(8500); // 10000 - 15%
  });

  it('contract tiers still win over dynamic pricing', async () => {
    await upsertContractPrice(testEnv, {
      tenant_id: 'dp4',
      account_id: 'acct',
      product_id: 'sku-1',
      currency: 'usd',
      tiers: [{ min_qty: 1, unit_price_cents: 7000 }],
      created_at: 1,
      updated_at: 1,
    });
    await upsertPricingRule(testEnv, {
      tenant_id: 'dp4',
      id: 'velo',
      scope: 'catalog',
      target: '',
      kind: 'velocity',
      adjustment_bps: -1000,
      config: { velocity_threshold: 1 },
      active: true,
      created_at: 1,
    });
    const res = await resolveEffectivePrice(testEnv, 'dp4', 'acct', 'sku-1', 5, 10_000, null, {
      category: 'apparel',
      signals: { nowMs: NOON, recentUnitsSold: 100 },
    });
    expect(res.source).toBe('contract');
    expect(res.unit_price_cents).toBe(7000);
  });
});
