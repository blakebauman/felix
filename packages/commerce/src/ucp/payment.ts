/**
 * Payment settlement for UCP `complete`.
 *
 * The platform sends a `payment_data` instrument whose `credential.token` is a
 * gateway token chargeable by our PSP (Stripe) — the buyer's real credentials
 * never reach us. Mirrors `../acp/payment.ts` (which settles ACP Shared
 * Payment Tokens): both confirm a PaymentIntent with the token as the payment
 * method, differing only in metadata and idempotency scope.
 *
 * `allow_redirects: 'never'` keeps this a single server-side call — agentic
 * checkout can't bounce the buyer through a redirect.
 */

import type { Env } from '@felix/harness/env';
import { stripeClient } from '../stripe-client';

export type UcpChargeResult =
  | { ok: true; paymentRef: string }
  | { ok: false; declined: boolean; message: string };

export async function chargeUcpToken(
  env: Env,
  args: { amount: number; currency: string; token: string; sessionId: string },
): Promise<UcpChargeResult> {
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
        metadata: { ucp_session_id: args.sessionId },
      },
      // Idempotency key scoped to the checkout session: a retried or concurrent
      // `complete` for the same session reuses the original PaymentIntent
      // instead of creating a second charge.
      { idempotencyKey: `ucp-complete-${args.sessionId}` },
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
