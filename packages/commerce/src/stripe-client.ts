/**
 * Shared Stripe client factory. On Cloudflare Workers the SDK must use the
 * fetch-based HTTP client (no Node `http`) and the Web Crypto provider for
 * webhook signature verification (`constructEventAsync`). Constructed per
 * call — the client is cheap and holds no durable state.
 */

import type { Env } from '@felix/harness/env';
import Stripe from 'stripe';

export function stripeClient(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY ?? '', {
    httpClient: Stripe.createFetchHttpClient(),
  });
}
