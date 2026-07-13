/**
 * Universal Commerce Protocol (UCP) merchant endpoints.
 *
 *   POST /ucp/checkout-sessions               → create
 *   GET  /ucp/checkout-sessions/:id           → retrieve
 *   PUT  /ucp/checkout-sessions/:id           → update (full replacement)
 *   POST /ucp/checkout-sessions/:id/complete  → charge + create order
 *   POST /ucp/checkout-sessions/:id/cancel    → cancel
 *
 * (The public discovery document lives at `/.well-known/ucp` — see
 * `discovery.ts`; its `services…rest.endpoint` points platforms at this
 * mount.)
 *
 * Auth is a bearer API key the merchant (us) issues to the calling platform,
 * compared in constant time against `env.UCP_API_KEY`. UCP is single-merchant
 * here: every session belongs to `env.UCP_MERCHANT_TENANT` (default
 * `default`), the same tenant whose catalog/orders the buyer-side agent uses.
 * No JWT here. HTTP-level errors use the reference server's `{ detail }`
 * problem shape; domain errors ride the session's `messages[]` per spec.
 *
 * A `UCP-Agent: … version="YYYY-MM-DD"` header newer than our spec version is
 * rejected up front (version negotiation per the UCP REST binding).
 *
 * Mounted at `/ucp` in `plugin.ts`.
 */

import { recordEventDetached } from '@felix/harness/audit/store';
import type { Env } from '@felix/harness/env';
import { constantTimeEqual } from '@felix/harness/security/constant-time';
import { Hono } from 'hono';
import { putAttribution } from '../consent/store';
import {
  buildUcpSession,
  finalizeUcpOrder,
  inputsFromSession,
  normalizeDestination,
  ucpSessionTotal,
} from './checkout';
import {
  UCP_VERSION,
  UcpCompleteRequest,
  UcpCreateRequest,
  type UcpDestination,
  type UcpFulfillmentInput,
  UcpUpdateRequest,
} from './models';
import { chargeUcpToken } from './payment';
import { getUcpSession, putUcpSession } from './session-store';

function merchantTenant(env: Env): string {
  return env.UCP_MERCHANT_TENANT || 'default';
}

/** HTTP-level problem shape used by the UCP reference merchant server. */
function detail(message: string) {
  return { detail: message };
}

/** Resolve the (single, shipping) destination + selected option from the
 * request's fulfillment extension block. */
function fulfillmentFromInput(f?: UcpFulfillmentInput): {
  destination?: UcpDestination;
  selectedOptionId?: string | null;
} {
  const method = f?.methods?.find((m) => (m.type ?? 'shipping') === 'shipping');
  if (!method) return {};
  const normalized = (method.destinations ?? []).map(normalizeDestination);
  const destination =
    (method.selected_destination_id
      ? normalized.find((d) => d.id === method.selected_destination_id)
      : undefined) ?? normalized[0];
  const selectedOptionId = method.groups?.find((g) => g.selected_option_id)?.selected_option_id;
  return { ...(destination ? { destination } : {}), selectedOptionId };
}

export function buildUcpRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Bearer API-key gate on every UCP route.
  app.use('*', async (c, next) => {
    const key = c.env.UCP_API_KEY;
    if (!key) return c.json(detail('UCP is not enabled on this deployment'), 503);
    const header = c.req.header('authorization') ?? '';
    const supplied = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!supplied || !(await constantTimeEqual(supplied, key))) {
      return c.json(detail('invalid API key'), 401);
    }
    await next();
  });

  // Version negotiation: reject platforms speaking a newer spec than ours.
  app.use('*', async (c, next) => {
    const agent = c.req.header('ucp-agent');
    const version = agent?.match(/version="([^"]+)"/)?.[1];
    if (version && version > UCP_VERSION) {
      return c.json(detail(`Unsupported UCP version: ${version} (server: ${UCP_VERSION})`), 400);
    }
    await next();
  });

  app.post('/checkout-sessions', async (c) => {
    const parsed = UcpCreateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(detail(parsed.error.message), 400);
    const tenant = merchantTenant(c.env);
    const nowMs = Date.now();
    const { destination, selectedOptionId } = fulfillmentFromInput(parsed.data.fulfillment);
    const session = await buildUcpSession(c.env, tenant, {
      id: `ucp_${crypto.randomUUID()}`,
      items: parsed.data.line_items.map((li) => ({ itemId: li.item.id, quantity: li.quantity })),
      buyer: parsed.data.buyer,
      destination,
      selectedOptionId,
      nowMs,
    });
    await putUcpSession(c.env, tenant, session, nowMs);
    return c.json(session, 201);
  });

  app.get('/checkout-sessions/:id', async (c) => {
    const found = await getUcpSession(c.env, merchantTenant(c.env), c.req.param('id'));
    if (!found) return c.json(detail('Checkout session not found'), 404);
    return c.json(found.session, 200);
  });

  app.put('/checkout-sessions/:id', async (c) => {
    const tenant = merchantTenant(c.env);
    const id = c.req.param('id');
    const found = await getUcpSession(c.env, tenant, id);
    if (!found) return c.json(detail('Checkout session not found'), 404);
    if (found.session.status === 'completed' || found.session.status === 'canceled') {
      return c.json(detail(`Cannot update a ${found.session.status} checkout session`), 409);
    }
    const parsed = UcpUpdateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(detail(parsed.error.message), 400);

    const prev = inputsFromSession(found.session);
    const nowMs = Date.now();
    const next = fulfillmentFromInput(parsed.data.fulfillment);
    const session = await buildUcpSession(c.env, tenant, {
      id,
      items: parsed.data.line_items
        ? parsed.data.line_items.map((li) => ({
            itemId: li.item.id,
            quantity: li.quantity,
            lineId: li.id,
          }))
        : prev.items,
      buyer: parsed.data.buyer ?? prev.buyer,
      destination: parsed.data.fulfillment ? next.destination : prev.destination,
      selectedOptionId: parsed.data.fulfillment
        ? (next.selectedOptionId ?? prev.selectedOptionId)
        : prev.selectedOptionId,
      nowMs,
    });
    await putUcpSession(c.env, tenant, session, nowMs);
    return c.json(session, 200);
  });

  app.post('/checkout-sessions/:id/complete', async (c) => {
    const tenant = merchantTenant(c.env);
    const id = c.req.param('id');
    const found = await getUcpSession(c.env, tenant, id);
    if (!found) return c.json(detail('Checkout session not found'), 404);
    // Idempotent: a completed session replays its stored result (charge +
    // order creation are both per-session idempotent underneath).
    if (found.session.status === 'completed') return c.json(found.session, 200);
    if (found.session.status === 'canceled') {
      return c.json(detail('Checkout session is canceled'), 409);
    }

    const parsed = UcpCompleteRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(detail(parsed.error.message), 400);
    const token = parsed.data.payment_data.credential?.token;
    if (!token) return c.json(detail('Missing payment credential token'), 400);

    const nowMs = Date.now();
    // Rebuild to lock in current pricing before charging.
    const session = await buildUcpSession(c.env, tenant, {
      id,
      ...inputsFromSession(found.session),
      nowMs,
    });

    if (session.status !== 'ready_for_complete') {
      session.messages.push({
        type: 'error',
        code: 'invalid',
        severity: 'recoverable',
        content_type: 'plain',
        content: 'Checkout is not ready to complete (missing destination, option, or stock).',
      });
      await putUcpSession(c.env, tenant, session, nowMs);
      return c.json(session, 200);
    }

    const charge = await chargeUcpToken(c.env, {
      amount: ucpSessionTotal(session),
      currency: session.currency,
      token,
      sessionId: id,
    });

    if (!charge.ok) {
      session.messages.push({
        type: 'error',
        code: 'payment_declined',
        severity: 'recoverable',
        content_type: 'plain',
        content: charge.message,
      });
      await putUcpSession(c.env, tenant, session, nowMs);
      return c.json(session, 200);
    }

    const order = await finalizeUcpOrder(c.env, tenant, session, charge.paymentRef, nowMs);
    session.status = 'completed';
    session.order_id = order.order_id;
    session.order_permalink_url = order.order_permalink_url;
    await putUcpSession(c.env, tenant, session, nowMs, order.order_id);
    await putAttribution(c.env, {
      tenant_id: tenant,
      order_id: order.order_id,
      channel: 'ucp',
      manifest_id: 'orderloop',
      thread_id: '',
      buyer_subject: session.buyer?.email ?? '',
      consent_id: '',
      utm: {},
      created_at: nowMs,
    });
    recordEventDetached(
      c.env,
      {
        tenantId: tenant,
        eventType: 'commerce_order',
        manifestId: 'orderloop',
        status: 'ok',
        payload: {
          source: 'ucp',
          order_id: order.order_id,
          checkout_session_id: id,
          payment_ref: charge.paymentRef,
          total_cents: ucpSessionTotal(session),
          currency: session.currency,
        },
      },
      c.executionCtx,
    );
    return c.json(session, 200);
  });

  app.post('/checkout-sessions/:id/cancel', async (c) => {
    const tenant = merchantTenant(c.env);
    const id = c.req.param('id');
    const found = await getUcpSession(c.env, tenant, id);
    if (!found) return c.json(detail('Checkout session not found'), 404);
    if (found.session.status === 'completed') {
      return c.json(detail('Cannot cancel a completed checkout session'), 409);
    }
    const nowMs = Date.now();
    const session = { ...found.session, status: 'canceled' as const };
    await putUcpSession(c.env, tenant, session, nowMs);
    return c.json(session, 200);
  });

  return app;
}
