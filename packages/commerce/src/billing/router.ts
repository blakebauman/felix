/**
 * Billing provider administration + the Stripe invoice webhook.
 *
 *   GET  /b2b/billing/provider     → this tenant's billing provider + the registered set
 *   PUT  /b2b/billing/provider     → choose a provider (internal / stripe / …)
 *   POST /b2b/billing/webhook      → Stripe `invoice.paid` → mark our invoice paid
 *
 * Provider config is operator-scoped (`b2b:write`). The webhook is a trusted 3p
 * call authenticated by Stripe's signature (no JWT); it maps back to our
 * invoice via the metadata we set when issuing it.
 *
 * Mounted at `/b2b/billing` in `app.ts`.
 */

import { recordEventDetached } from '@felix/harness/audit/store';
import type { AuthContext } from '@felix/harness/auth/context';
import { requireScope } from '@felix/harness/auth/middleware';
import type { Env } from '@felix/harness/env';
import { Hono } from 'hono';
import { z } from 'zod';
import { markInvoicePaidByRef } from '../b2b/service';
import { verifyStripeEvent } from '../webhook-verify';
import { getBillingSettings, setBillingSettings } from './config-store';
import { listBillingProviders } from './registry';
import './internal';
import './stripe';

const WRITE_SCOPE = 'b2b:write';
type Vars = { Variables: { auth: AuthContext } };

const SetProviderSchema = z
  .object({
    provider: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export function buildBillingRouter(): Hono<{ Bindings: Env } & Vars> {
  const app = new Hono<{ Bindings: Env } & Vars>();

  app.get('/provider', async (c) => {
    const tenant = c.get('auth').principal.tenantId;
    const settings = await getBillingSettings(c.env, tenant);
    return c.json({ ...settings, available: listBillingProviders() }, 200);
  });

  app.put('/provider', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const parsed = SetProviderSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
    if (!listBillingProviders().includes(parsed.data.provider))
      return c.json({ error: 'unknown_provider', available: listBillingProviders() }, 400);
    await setBillingSettings(
      c.env,
      c.get('auth').principal.tenantId,
      { provider: parsed.data.provider, config: parsed.data.config ?? {} },
      c.get('auth').principal.subject,
    );
    return c.json({ ok: true }, 200);
  });

  app.post('/webhook', async (c) => {
    const secret = c.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: 'webhook not configured' }, 503);
    const signature = c.req.header('stripe-signature');
    if (!signature) return c.json({ error: 'missing signature' }, 400);
    const raw = await c.req.text();
    const verified = await verifyStripeEvent(c.env, raw, signature, secret);
    if (!verified.ok) return c.json({ error: verified.error }, 400);
    const event = verified.event;

    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
      const obj = event.data.object as {
        metadata?: { orderloop_tenant?: string; orderloop_invoice_id?: string };
      };
      const tenant = obj.metadata?.orderloop_tenant;
      const invoiceId = obj.metadata?.orderloop_invoice_id;
      if (tenant && invoiceId) {
        const marked = await markInvoicePaidByRef(c.env, tenant, invoiceId);
        if (marked) {
          recordEventDetached(
            c.env,
            {
              tenantId: tenant,
              eventType: 'b2b_quote',
              manifestId: 'orderloop',
              status: 'ok',
              payload: { source: 'billing_webhook', invoice_id: invoiceId, event: event.type },
            },
            c.executionCtx,
          );
        }
      }
    }
    return c.json({ received: true }, 200);
  });

  return app;
}
