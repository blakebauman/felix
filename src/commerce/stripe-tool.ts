/**
 * Stripe-direct checkout. `commerce_checkout` reads the session cart,
 * recomputes the total server-side (never trusting model arithmetic), and
 * creates a hosted Stripe Checkout Session, returning the pay URL.
 *
 * The tool is gated by a `spec.approvals[]` rule on `commerce_checkout`: the
 * first call is denied pending human confirmation; the retry after
 * `POST /approvals/{id}/decide` actually creates the session. The webhook
 * (`webhook.ts`) converts the completed session into an order.
 *
 * Payment never touches Felix — Stripe hosts the card capture. We only hold
 * the secret key and create sessions.
 */

import type Stripe from 'stripe';
import { z } from 'zod';
import { getContext } from '../context';
import type { Env } from '../env';
import { toolErrorOutput } from '../tools/errors';
import { defineTool, type Tool, type ToolOutput } from '../tools/types';
import { readCart } from './cart-session';
import { latestConsentForThread } from './consent/store';
import { type Cart, cartTotalCents } from './models';
import { shippingOptions } from './shipping';
import { stripeClient } from './stripe-client';

/** Default redirect targets; overridable via env for non-prod. */
function successUrl(env: Env): string {
  return (
    env.STRIPE_SUCCESS_URL || 'https://shop.felix.run/checkout/success?cs={CHECKOUT_SESSION_ID}'
  );
}
function cancelUrl(env: Env): string {
  return env.STRIPE_CANCEL_URL || 'https://shop.felix.run/checkout/cancel';
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/** ISO-3166 alpha-2 countries we collect a shipping address for. */
function shipCountries(
  env: Env,
): Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] {
  const raw = (env.COMMERCE_SHIP_COUNTRIES || 'US')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return raw as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[];
}

/** Map our configured shipping options to Stripe shipping_rate_data. */
async function stripeShippingOptions(
  env: Env,
  cart: Cart,
): Promise<Stripe.Checkout.SessionCreateParams.ShippingOption[]> {
  const subtotalCents = cartTotalCents(cart.items);
  return (await shippingOptions(env, { subtotalCents })).map((o) => ({
    shipping_rate_data: {
      type: 'fixed_amount',
      display_name: o.title,
      fixed_amount: { amount: o.amount_cents, currency: cart.currency },
      delivery_estimate: {
        minimum: { unit: 'business_day', value: o.min_days },
        maximum: { unit: 'business_day', value: o.max_days },
      },
    },
  }));
}

/** Attribution stamped onto the Stripe session metadata and read back by the webhook. */
export interface CheckoutAttribution {
  channel: string;
  manifestId: string;
  buyerSubject: string;
  consentId: string;
}

export async function createCheckoutSession(
  env: Env,
  args: { cart: Cart; tenantId: string; threadId: string; attribution?: CheckoutAttribution },
): Promise<CheckoutSession> {
  const { cart, tenantId, threadId, attribution } = args;
  // Stripe Tax requires it to be enabled on the account; gate behind a flag so
  // dev/test (and accounts without Stripe Tax) don't fail session creation.
  const automaticTax = env.STRIPE_AUTOMATIC_TAX === 'true';
  const session = await stripeClient(env).checkout.sessions.create({
    mode: 'payment',
    success_url: successUrl(env),
    cancel_url: cancelUrl(env),
    client_reference_id: threadId,
    metadata: {
      tenant_id: tenantId,
      thread_id: threadId,
      channel: attribution?.channel ?? 'chat',
      manifest_id: attribution?.manifestId ?? 'orderloop',
      buyer_subject: attribution?.buyerSubject ?? '',
      consent_id: attribution?.consentId ?? '',
    },
    line_items: cart.items.map((it) => ({
      quantity: it.qty,
      price_data: {
        currency: cart.currency,
        unit_amount: it.price_cents,
        product_data: { name: it.title || it.product_id },
      },
    })),
    shipping_address_collection: { allowed_countries: shipCountries(env) },
    shipping_options: await stripeShippingOptions(env, cart),
    ...(automaticTax ? { automatic_tax: { enabled: true } } : {}),
  });
  if (!session.url) throw new Error('stripe: checkout session has no url');
  return { id: session.id, url: session.url };
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function commerceCheckoutTool(): Tool {
  return defineTool({
    name: 'commerce_checkout',
    description:
      'Create a Stripe checkout session for the current cart and return a secure payment ' +
      'URL. Requires human approval before charging. Call this only after the user has ' +
      'confirmed they want to buy the items in their cart.',
    args: z.object({}).strict(),
    source: 'commerce',
    async handler(_args, ctx): Promise<ToolOutput> {
      const rc = getContext();
      if (!rc) return toolErrorOutput('internal', '[commerce error] no request context');
      const env = rc.env;
      const tenantId = rc.auth.principal.tenantId;
      const threadId = ctx?.threadId ?? '';
      if (!threadId) {
        return toolErrorOutput(
          'invalid_arguments',
          '[commerce error] checkout requires a session thread; none was provided.',
        );
      }
      if (!env.STRIPE_SECRET_KEY) {
        return toolErrorOutput(
          'transport_unavailable',
          '[commerce error] Stripe is not configured (STRIPE_SECRET_KEY unset).',
        );
      }
      const cart = await readCart(env, threadId);
      if (cart.items.length === 0) {
        return 'Your cart is empty — add items before checking out.';
      }
      // Consent gate (opt-in): when required, a granted consent must exist for
      // this thread. Always look it up so its id can be stamped for attribution.
      const consent = await latestConsentForThread(env, tenantId, threadId);
      if (env.COMMERCE_REQUIRE_CONSENT === 'true' && !consent?.granted) {
        return (
          'Before I can check you out, I need your consent to the terms and to sharing your ' +
          'details to complete the purchase. Do you agree?'
        );
      }
      const total = cartTotalCents(cart.items);
      try {
        const session = await createCheckoutSession(env, {
          cart,
          tenantId,
          threadId,
          attribution: {
            channel: 'chat',
            manifestId: rc.manifestId ?? 'orderloop',
            buyerSubject: rc.auth.principal.subject ?? '',
            consentId: consent?.granted ? consent.id : '',
          },
        });
        const lines = cart.items
          .map((it) => `- ${it.qty}× ${it.title || it.product_id} (${dollars(it.price_cents)} ea)`)
          .join('\n');
        return (
          `Checkout ready — total ${dollars(total)} (${cart.currency.toUpperCase()}).\n` +
          `${lines}\n\nPay securely here: ${session.url}`
        );
      } catch (err) {
        return toolErrorOutput(
          'provider_error',
          `[commerce error] could not create checkout: ${(err as Error).message}`,
        );
      }
    },
  });
}
