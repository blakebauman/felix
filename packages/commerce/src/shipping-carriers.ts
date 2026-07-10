/**
 * Carrier rate-shopping seam. When `COMMERCE_CARRIERS` (JSON) is configured, the
 * shipping options are quoted per-carrier and returned cheapest-first — "rate
 * shopping" across carriers.
 *
 * Each carrier is either:
 *   - **static**: rates computed from declared `services`
 *     (`base_cents + per_item_cents × itemCount`, scaled by a destination zone
 *     multiplier) — the zero-dependency default; or
 *   - **live**: a carrier with a `url`, which is POSTed the cart context and
 *     returns real-time rates. This is where a UPS/FedEx/DHL integration plugs
 *     in (typically via a brand-owned proxy that holds the carrier credentials).
 *     A live carrier falls back to its static `services` if the call fails.
 *
 * Invalid/missing config means "no carriers configured" and the caller keeps its
 * static `COMMERCE_SHIPPING` fallback.
 */

import type { Env } from '@felix/orchestrator/env';
import { assertSafeOutboundUrlForEnv } from '@felix/orchestrator/security/ssrf';
import type { ShippingOption } from './shipping';

interface CarrierService {
  id: string;
  title: string;
  subtitle?: string;
  base_cents: number;
  per_item_cents?: number;
  min_days: number;
  max_days: number;
}

interface CarrierSpec {
  id: string;
  carrier: string;
  /** Live rate endpoint. Absent → static `services` are used. */
  url?: string;
  /** Literal `Authorization` header value for the live endpoint. */
  auth?: string;
  services: CarrierService[];
}

interface CarrierConfig {
  carriers: CarrierSpec[];
  /** Multiplier applied to static rates when the destination is non-domestic. */
  intl_multiplier?: number;
  /** ISO-3166 alpha-2 codes treated as domestic (default ['US']). */
  domestic_countries?: string[];
}

export interface RateShopInput {
  itemCount: number;
  destinationCountry?: string;
  subtotalCents: number;
  signal?: AbortSignal;
}

function isService(v: unknown): v is CarrierService {
  const o = v as Record<string, unknown>;
  return (
    !!o &&
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    typeof o.base_cents === 'number' &&
    o.base_cents >= 0 &&
    typeof o.min_days === 'number' &&
    typeof o.max_days === 'number'
  );
}

export function parseCarrierConfig(env: Env): CarrierConfig | null {
  const raw = env.COMMERCE_CARRIERS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CarrierConfig>;
    const carriers = (Array.isArray(parsed.carriers) ? parsed.carriers : [])
      .map((carrier) => ({
        id: String(carrier?.id ?? ''),
        carrier: String(carrier?.carrier ?? carrier?.id ?? ''),
        url: typeof carrier?.url === 'string' ? carrier.url : undefined,
        auth: typeof carrier?.auth === 'string' ? carrier.auth : undefined,
        services: (Array.isArray(carrier?.services) ? carrier.services : []).filter(isService),
      }))
      // Keep a carrier if it can produce rates: static services OR a live url.
      .filter((c) => c.id && (c.services.length > 0 || c.url));
    if (carriers.length === 0) return null;
    return {
      carriers,
      intl_multiplier:
        typeof parsed.intl_multiplier === 'number' && parsed.intl_multiplier > 0
          ? parsed.intl_multiplier
          : 1,
      domestic_countries: Array.isArray(parsed.domestic_countries)
        ? parsed.domestic_countries.map((c) => String(c).toUpperCase())
        : ['US'],
    };
  } catch {
    return null;
  }
}

function staticRates(
  carrier: CarrierSpec,
  itemCount: number,
  multiplier: number,
): ShippingOption[] {
  return carrier.services.map((svc) => ({
    id: `${carrier.id}_${svc.id}`,
    title: svc.title,
    subtitle: svc.subtitle ?? `${svc.min_days}–${svc.max_days} business days`,
    carrier: carrier.carrier,
    amount_cents: Math.round((svc.base_cents + (svc.per_item_cents ?? 0) * itemCount) * multiplier),
    min_days: svc.min_days,
    max_days: svc.max_days,
  }));
}

function isOption(v: unknown): v is ShippingOption {
  const o = v as Record<string, unknown>;
  return !!o && typeof o.id === 'string' && typeof o.amount_cents === 'number';
}

/** Quote a live carrier endpoint. Returns null on any failure (→ static fallback). */
async function liveRates(
  env: Env,
  carrier: CarrierSpec,
  input: RateShopInput,
): Promise<ShippingOption[] | null> {
  if (!carrier.url) return null;
  try {
    // Operator-configured carrier endpoint that receives the carrier auth
    // header — SSRF-guard it for consistency so a misconfigured URL can't leak
    // those credentials to an internal host.
    assertSafeOutboundUrlForEnv(carrier.url, env);
    const res = await fetch(carrier.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(carrier.auth ? { authorization: carrier.auth } : {}),
      },
      body: JSON.stringify({
        item_count: input.itemCount,
        destination_country: input.destinationCountry ?? '',
        subtotal_cents: input.subtotalCents,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { options?: unknown };
    const opts = (Array.isArray(body.options) ? body.options : []).filter(isOption).map((o) => ({
      id: `${carrier.id}_${o.id}`,
      title: o.title,
      subtitle: o.subtitle ?? '',
      carrier: o.carrier || carrier.carrier,
      amount_cents: o.amount_cents,
      min_days: o.min_days ?? 0,
      max_days: o.max_days ?? 0,
    }));
    return opts.length > 0 ? opts : null;
  } catch {
    return null;
  }
}

/** Quote every configured carrier (live where available) and sort cheapest-first. */
export async function rateShop(env: Env, input: RateShopInput): Promise<ShippingOption[]> {
  const config = parseCarrierConfig(env);
  if (!config) return [];
  const domestic = new Set(config.domestic_countries ?? ['US']);
  const dest = (input.destinationCountry ?? '').toUpperCase();
  const isIntl = dest !== '' && !domestic.has(dest);
  const multiplier = isIntl ? (config.intl_multiplier ?? 1) : 1;
  const itemCount = Math.max(1, input.itemCount);

  const quotes = await Promise.all(
    config.carriers.map(async (carrier) => {
      if (carrier.url) {
        const live = await liveRates(env, carrier, input);
        if (live) return live;
      }
      return staticRates(carrier, itemCount, multiplier);
    }),
  );
  return quotes.flat().sort((a, b) => a.amount_cents - b.amount_cents);
}
