/**
 * Agentic Commerce Protocol (ACP) merchant endpoints.
 *
 *   GET  /acp/feed                              → product feed
 *   POST /acp/checkout_sessions                 → create
 *   GET  /acp/checkout_sessions/:id             → retrieve
 *   POST /acp/checkout_sessions/:id             → update
 *   POST /acp/checkout_sessions/:id/complete    → charge + create order
 *   POST /acp/checkout_sessions/:id/cancel      → cancel
 *
 * Auth is a bearer API key the merchant (us) issues to the calling agent,
 * compared in constant time against `env.ACP_API_KEY`. ACP is single-merchant:
 * every session belongs to `env.ACP_MERCHANT_TENANT` (default `default`), the
 * same tenant whose catalog/orders the buyer-side agent uses. No JWT here.
 *
 * Mounted at `/acp` in `app.ts`.
 */

import { recordEventDetached } from '@felix/harness/audit/store';
import type { Env } from '@felix/harness/env';
import { constantTimeEqual } from '@felix/harness/security/constant-time';
import { Hono } from 'hono';
import { putAttribution } from '../consent/store';
import { buildSession, finalizeOrder, sessionTotal } from './checkout';
import { buildFeed } from './feed';
import {
  type AcpCheckoutSession,
  CompleteSessionRequest,
  CreateSessionRequest,
  UpdateSessionRequest,
} from './models';
import { chargeSharedPaymentToken } from './payment';
import { getSession, putSession } from './session-store';

function merchantTenant(env: Env): string {
  return env.ACP_MERCHANT_TENANT || 'default';
}

function acpError(code: string, message: string) {
  return { type: 'invalid_request', code, message };
}

/** Reconstruct the create-style input list from a stored session's line items. */
function itemsFromSession(session: AcpCheckoutSession) {
  return session.line_items.map((li) => ({ id: li.item.id, quantity: li.item.quantity }));
}

export function buildAcpRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Bearer API-key gate on every ACP route.
  app.use('*', async (c, next) => {
    const key = c.env.ACP_API_KEY;
    if (!key)
      return c.json(acpError('not_configured', 'ACP is not enabled on this deployment'), 503);
    const header = c.req.header('authorization') ?? '';
    const supplied = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!supplied || !(await constantTimeEqual(supplied, key))) {
      return c.json(acpError('unauthorized', 'invalid API key'), 401);
    }
    await next();
  });

  app.get('/feed', async (c) => {
    const limit = Number.parseInt(c.req.query('limit') ?? '', 10);
    const offset = Number.parseInt(c.req.query('offset') ?? '', 10);
    const feed = await buildFeed(c.env, merchantTenant(c.env), {
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(offset) ? { offset } : {}),
    });
    return c.json(feed, 200);
  });

  app.post('/checkout_sessions', async (c) => {
    const parsed = CreateSessionRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(acpError('invalid', parsed.error.message), 400);
    const tenant = merchantTenant(c.env);
    const nowMs = Date.now();
    const session = await buildSession(c.env, tenant, {
      id: `acp_${crypto.randomUUID()}`,
      items: parsed.data.items,
      buyer: parsed.data.buyer,
      fulfillment_address: parsed.data.fulfillment_address,
      nowMs,
    });
    await putSession(c.env, tenant, session, nowMs);
    return c.json(session, 201);
  });

  app.get('/checkout_sessions/:id', async (c) => {
    const found = await getSession(c.env, merchantTenant(c.env), c.req.param('id'));
    if (!found) return c.json(acpError('not_found', 'checkout session not found'), 404);
    return c.json(found.session, 200);
  });

  app.post('/checkout_sessions/:id', async (c) => {
    const tenant = merchantTenant(c.env);
    const id = c.req.param('id');
    const found = await getSession(c.env, tenant, id);
    if (!found) return c.json(acpError('not_found', 'checkout session not found'), 404);
    if (found.session.status === 'completed' || found.session.status === 'canceled') {
      return c.json(found.session, 200); // terminal — no-op update
    }
    const parsed = UpdateSessionRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(acpError('invalid', parsed.error.message), 400);
    const prev = found.session;
    const nowMs = Date.now();
    const session = await buildSession(c.env, tenant, {
      id,
      items: parsed.data.items ?? itemsFromSession(prev),
      buyer: parsed.data.buyer ?? prev.buyer,
      fulfillment_address: parsed.data.fulfillment_address ?? prev.fulfillment_address,
      fulfillment_option_id: parsed.data.fulfillment_option_id ?? prev.fulfillment_option_id,
      nowMs,
    });
    await putSession(c.env, tenant, session, nowMs);
    return c.json(session, 200);
  });

  app.post('/checkout_sessions/:id/complete', async (c) => {
    const tenant = merchantTenant(c.env);
    const id = c.req.param('id');
    const found = await getSession(c.env, tenant, id);
    if (!found) return c.json(acpError('not_found', 'checkout session not found'), 404);
    // Idempotent: a session already completed returns its stored result.
    if (found.session.status === 'completed') return c.json(found.session, 200);

    const parsed = CompleteSessionRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(acpError('invalid', parsed.error.message), 400);

    const nowMs = Date.now();
    // Rebuild to lock in current pricing + merge the buyer from the complete call.
    const prev = found.session;
    const session = await buildSession(c.env, tenant, {
      id,
      items: itemsFromSession(prev),
      buyer: parsed.data.buyer ?? prev.buyer,
      fulfillment_address: prev.fulfillment_address,
      fulfillment_option_id: prev.fulfillment_option_id,
      nowMs,
    });

    if (session.status !== 'ready_for_payment') {
      session.messages.push({
        type: 'error',
        code: 'invalid',
        content_type: 'plain',
        content: 'Checkout is not ready for payment (missing address, option, or stock).',
      });
      await putSession(c.env, tenant, session, nowMs);
      return c.json(session, 200);
    }

    const charge = await chargeSharedPaymentToken(c.env, {
      amount: sessionTotal(session),
      currency: session.currency,
      token: parsed.data.payment_data.token,
      sessionId: id,
    });

    if (!charge.ok) {
      session.messages.push({
        type: 'error',
        code: 'payment_declined',
        content_type: 'plain',
        content: charge.message,
      });
      await putSession(c.env, tenant, session, nowMs);
      return c.json(session, 200);
    }

    const order = await finalizeOrder(c.env, tenant, session, charge.paymentRef, nowMs);
    session.status = 'completed';
    session.order = order;
    await putSession(c.env, tenant, session, nowMs, order.id);
    await putAttribution(c.env, {
      tenant_id: tenant,
      order_id: order.id,
      channel: 'acp',
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
          source: 'acp',
          order_id: order.id,
          checkout_session_id: id,
          payment_ref: charge.paymentRef,
          total_cents: sessionTotal(session),
          currency: session.currency,
        },
      },
      c.executionCtx,
    );
    return c.json(session, 200);
  });

  app.post('/checkout_sessions/:id/cancel', async (c) => {
    const tenant = merchantTenant(c.env);
    const id = c.req.param('id');
    const found = await getSession(c.env, tenant, id);
    if (!found) return c.json(acpError('not_found', 'checkout session not found'), 404);
    const nowMs = Date.now();
    const session = { ...found.session, status: 'canceled' as const };
    await putSession(c.env, tenant, session, nowMs);
    return c.json(session, 200);
  });

  return app;
}
