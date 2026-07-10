/**
 * Shared Stripe webhook signature verification (Workers/edge: Web Crypto via
 * `constructEventAsync` + the SubtleCrypto provider). Used by both the
 * buyer-side checkout webhook and the B2B billing webhook.
 */

import Stripe from 'stripe';
import type { Env } from '../env';
import { stripeClient } from './stripe-client';

export type VerifyResult = { ok: true; event: Stripe.Event } | { ok: false; error: string };

export async function verifyStripeEvent(
  env: Env,
  rawBody: string,
  signature: string,
  secret: string,
): Promise<VerifyResult> {
  try {
    const event = await stripeClient(env).webhooks.constructEventAsync(
      rawBody,
      signature,
      secret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
    return { ok: true, event };
  } catch (err) {
    return { ok: false, error: `invalid signature: ${(err as Error).message}` };
  }
}
