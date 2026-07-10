/**
 * Stripe webhook → order conversion.
 *
 *   POST /commerce/stripe/webhook
 *
 * Authenticated by Stripe's signature scheme (HMAC-SHA256 over
 * `${t}.${rawBody}` with `STRIPE_WEBHOOK_SECRET`), verified in constant time.
 * There is no JWT here — Stripe is the caller. On `checkout.session.completed`
 * we read the session-backed cart (keyed by the `client_reference_id` thread
 * id), write an `orders` row, clear the cart, and emit a `commerce_order`
 * audit event. Runs detached (no RequestContext) — stores take `env` directly.
 *
 * Mounted under `/commerce` in `app.ts`.
 */

import { Hono } from 'hono';
import Stripe from 'stripe';
import { recordEventDetached } from '../audit/store';
import type { Env } from '../env';
import { readCart, writeCart } from './cart-session';
import { decrementInventory } from './catalog-store';
import { putAttribution } from './consent/store';
import { cartTotalCents, type Order } from './models';
import { createOrder } from './order-store';
import { getSessionCustomer, recordBehaviorEvent } from './personalization/customer-store';
import { stripeClient } from './stripe-client';

function tenantFromThreadId(threadId: string): string {
  const colon = threadId.indexOf(':');
  return colon > 0 ? threadId.slice(0, colon) : 'default';
}

interface CheckoutSessionCompleted {
  id: string;
  client_reference_id?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  metadata?: {
    tenant_id?: string;
    thread_id?: string;
    channel?: string;
    manifest_id?: string;
    buyer_subject?: string;
    consent_id?: string;
  } | null;
}

export async function handleCheckoutCompleted(
  env: Env,
  session: CheckoutSessionCompleted,
  execCtx?: ExecutionContext,
): Promise<void> {
  const threadId = session.client_reference_id || session.metadata?.thread_id || '';
  const tenantId = session.metadata?.tenant_id || tenantFromThreadId(threadId);
  const cart = await readCart(env, threadId);
  const items = cart.items.map((it) => ({
    product_id: it.product_id,
    title: it.title,
    qty: it.qty,
    price_cents: it.price_cents,
  }));
  const total = session.amount_total ?? cartTotalCents(items);
  const order: Order = {
    tenant_id: tenantId,
    id: crypto.randomUUID(),
    thread_id: threadId,
    stripe_ref: session.id,
    total_cents: total,
    currency: (session.currency || cart.currency || 'usd').toLowerCase(),
    status: 'paid',
    created_at: Date.now(),
    items,
  };
  await createOrder(env, order);
  await decrementInventory(
    env,
    tenantId,
    items.map((it) => ({ id: it.product_id, qty: it.qty })),
  );
  // Record purchase behavior so the abandoned-cart scan sees the thread as
  // converted and recommendations learn from completed buys.
  const customerId = threadId ? ((await getSessionCustomer(env, tenantId, threadId)) ?? '') : '';
  for (const it of items) {
    await recordBehaviorEvent(env, {
      tenant_id: tenantId,
      type: 'purchase',
      thread_id: threadId,
      customer_id: customerId,
      product_id: it.product_id,
      ts: order.created_at,
    });
  }
  // Record attribution so the brand knows which agent/channel drove the sale.
  await putAttribution(env, {
    tenant_id: tenantId,
    order_id: order.id,
    channel: session.metadata?.channel || 'chat',
    manifest_id: session.metadata?.manifest_id || 'orderloop',
    thread_id: threadId,
    buyer_subject: session.metadata?.buyer_subject || '',
    consent_id: session.metadata?.consent_id || '',
    utm: {},
    created_at: order.created_at,
  });
  // Clear the cart so the thread starts fresh post-purchase.
  if (threadId)
    await writeCart(env, threadId, {
      items: [],
      currency: order.currency,
      updated_at: order.created_at,
    });
  recordEventDetached(
    env,
    {
      tenantId,
      eventType: 'commerce_order',
      manifestId: 'orderloop',
      status: 'ok',
      payload: {
        order_id: order.id,
        stripe_ref: order.stripe_ref,
        total_cents: order.total_cents,
        currency: order.currency,
        thread_id: threadId,
        item_count: items.length,
        channel: session.metadata?.channel || 'chat',
        consent_id: session.metadata?.consent_id || '',
      },
    },
    execCtx,
  );
}

export function buildCommerceRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/stripe/webhook', async (c) => {
    const secret = c.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      return c.json({ error: 'stripe webhook not configured' }, 503);
    }
    const signature = c.req.header('stripe-signature');
    if (!signature) {
      return c.json({ error: 'missing signature' }, 400);
    }
    const raw = await c.req.text();
    let event: Stripe.Event;
    try {
      // constructEventAsync uses Web Crypto — required on Workers (the sync
      // constructEvent uses Node crypto and throws on the edge runtime).
      event = await stripeClient(c.env).webhooks.constructEventAsync(
        raw,
        signature,
        secret,
        undefined,
        Stripe.createSubtleCryptoProvider(),
      );
    } catch (err) {
      return c.json({ error: `invalid signature: ${(err as Error).message}` }, 400);
    }
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(
        c.env,
        event.data.object as CheckoutSessionCompleted,
        c.executionCtx,
      );
    }
    // Acknowledge all other event types without action.
    return c.json({ received: true }, 200);
  });

  return app;
}
