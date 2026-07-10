/**
 * Delegated-payment settlement for ACP `complete`.
 *
 * The agent passes a Stripe Shared Payment Token (`payment_data.token`) scoped
 * to this merchant and cart total. We settle it by creating + confirming a
 * PaymentIntent with the token as the payment method — Stripe is the merchant's
 * PSP and the buyer's real credentials never reach us (OpenAI is not the
 * merchant of record; we bring our own PSP).
 *
 * `allow_redirects: 'never'` keeps this a single server-side call — agentic
 * checkout can't bounce the buyer through a redirect.
 */

import type { Env } from '../../env';
import { stripeClient } from '../stripe-client';

export type ChargeResult =
  | { ok: true; paymentRef: string }
  | { ok: false; declined: boolean; message: string };

export async function chargeSharedPaymentToken(
  env: Env,
  args: { amount: number; currency: string; token: string; sessionId: string },
): Promise<ChargeResult> {
  if (!env.STRIPE_SECRET_KEY) {
    return { ok: false, declined: false, message: 'payment processor not configured' };
  }
  try {
    const intent = await stripeClient(env).paymentIntents.create(
      {
        amount: args.amount,
        currency: args.currency,
        payment_method: args.token,
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: { acp_session_id: args.sessionId },
      },
      // Idempotency key scoped to the checkout session: a retried or concurrent
      // `complete` for the same session reuses the original PaymentIntent
      // instead of creating a second charge.
      { idempotencyKey: `acp-complete-${args.sessionId}` },
    );
    if (intent.status === 'succeeded' || intent.status === 'processing') {
      return { ok: true, paymentRef: intent.id };
    }
    return { ok: false, declined: true, message: `payment ${intent.status}` };
  } catch (err) {
    // Stripe card errors surface as exceptions on confirm; treat as a decline.
    return { ok: false, declined: true, message: (err as Error).message };
  }
}
