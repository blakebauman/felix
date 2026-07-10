/**
 * Shipping seam. Options are configurable via the `COMMERCE_SHIPPING` env var
 * (JSON); invalid/missing config falls back to sensible defaults so a bad
 * override degrades rather than disables shipping. An optional
 * `free_threshold_cents` zeroes the cheapest option once the subtotal clears
 * it (a common merchandising lever).
 *
 * Time-agnostic: options carry `min_days` / `max_days`; callers turn those into
 * RFC-3339 delivery windows so this module needs no clock.
 */

import type { Env } from '@felix/orchestrator/env';
import { rateShop } from './shipping-carriers';

export interface ShippingOption {
  id: string;
  title: string;
  subtitle: string;
  carrier: string;
  amount_cents: number;
  min_days: number;
  max_days: number;
}

interface ShippingConfig {
  free_threshold_cents?: number;
  options: ShippingOption[];
}

const DEFAULT_CONFIG: ShippingConfig = {
  options: [
    {
      id: 'standard',
      title: 'Standard shipping',
      subtitle: '5–7 business days',
      carrier: 'USPS',
      amount_cents: 500,
      min_days: 5,
      max_days: 7,
    },
    {
      id: 'express',
      title: 'Express shipping',
      subtitle: '2–3 business days',
      carrier: 'UPS',
      amount_cents: 1500,
      min_days: 2,
      max_days: 3,
    },
  ],
};

function isOption(v: unknown): v is ShippingOption {
  const o = v as Record<string, unknown>;
  return (
    !!o &&
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    typeof o.amount_cents === 'number' &&
    o.amount_cents >= 0 &&
    typeof o.min_days === 'number' &&
    typeof o.max_days === 'number'
  );
}

export function parseShippingConfig(env: Env): ShippingConfig {
  const raw = env.COMMERCE_SHIPPING;
  if (!raw) return DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<ShippingConfig>;
    const options = Array.isArray(parsed.options) ? parsed.options.filter(isOption) : [];
    if (options.length === 0) return DEFAULT_CONFIG;
    const threshold =
      typeof parsed.free_threshold_cents === 'number' && parsed.free_threshold_cents > 0
        ? parsed.free_threshold_cents
        : undefined;
    return { options, ...(threshold ? { free_threshold_cents: threshold } : {}) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Resolve the shipping options for a cart, applying the free-shipping threshold
 * to the cheapest option. When carrier rate-shopping is configured
 * (`COMMERCE_CARRIERS`), options come from quoting the carriers for this cart
 * (item count + destination); otherwise the static `COMMERCE_SHIPPING` config is
 * used. The free-threshold logic applies to whichever source is active.
 */
export async function shippingOptions(
  env: Env,
  input: { subtotalCents: number; itemCount?: number; destinationCountry?: string },
): Promise<ShippingOption[]> {
  const config = parseShippingConfig(env);
  const quoted = await rateShop(env, {
    itemCount: input.itemCount ?? 1,
    subtotalCents: input.subtotalCents,
    destinationCountry: input.destinationCountry,
  });
  const base = quoted.length > 0 ? quoted : config.options;
  const sorted = [...base].sort((a, b) => a.amount_cents - b.amount_cents);
  const freeId =
    config.free_threshold_cents !== undefined && input.subtotalCents >= config.free_threshold_cents
      ? sorted[0]?.id
      : undefined;
  return sorted.map((o) =>
    o.id === freeId ? { ...o, amount_cents: 0, subtitle: `${o.subtitle} · Free` } : o,
  );
}
