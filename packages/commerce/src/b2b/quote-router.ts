/**
 * Quote-to-cash HTTP surface — a thin mapping over `service.ts` (shared with
 * the procurement agent tools).
 *
 *   POST /b2b/quotes · GET /b2b/quotes · GET /b2b/quotes/:id
 *   POST /b2b/quotes/:id/send · /accept · /convert
 *   GET /b2b/invoices/:id · POST /b2b/invoices/:id/pay
 *
 * Writes gated by `b2b:write`; reads go through the entity seam.
 */

import type { AuthContext } from '@felix/orchestrator/auth/context';
import { requireScope } from '@felix/orchestrator/auth/middleware';
import type { Env } from '@felix/orchestrator/env';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { resolveEntitySource } from '../entities/resolver';
import { CreateQuoteRequest, type Invoice, type Quote, SendQuoteRequest } from './quote-models';
import {
  acceptQuote,
  convertQuote,
  createQuote,
  payInvoice,
  type Result,
  sendQuote,
} from './service';

const WRITE_SCOPE = 'b2b:write';
type Vars = { Variables: { auth: AuthContext } };

function tenantOf(c: { get: (k: 'auth') => AuthContext }): string {
  return c.get('auth').principal.tenantId;
}

const STATUS: Record<string, ContentfulStatusCode> = {
  not_found: 404,
  account_not_found: 404,
  buyer_not_found: 404,
  account_or_buyer_not_found: 404,
  pricing_failed: 400,
  invalid_state: 409,
  expired: 409,
  not_authorized: 409,
  not_ready: 409,
  buyer_not_in_account: 409,
  account_or_buyer_missing: 409,
};

// biome-ignore lint/suspicious/noExplicitAny: generic Hono json helper
function respond(c: any, r: Result<unknown>, okStatus: ContentfulStatusCode = 200) {
  if (r.ok) return c.json(r.value, okStatus);
  return c.json(
    { error: r.code, ...(r.detail !== undefined ? { detail: r.detail } : {}) },
    STATUS[r.code] ?? 400,
  );
}

export function buildB2bQuotesRouter(): Hono<{ Bindings: Env } & Vars> {
  const app = new Hono<{ Bindings: Env } & Vars>();

  app.post('/quotes', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const parsed = CreateQuoteRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
    return respond(c, await createQuote(c.env, tenantOf(c), parsed.data), 201);
  });

  app.get('/quotes', async (c) => {
    const source = await resolveEntitySource<Quote>(c.env, tenantOf(c), 'quote');
    return c.json({ quotes: (await source.list({ limit: 200 })).items, source: source.mode }, 200);
  });

  app.get('/quotes/:id', async (c) => {
    const source = await resolveEntitySource<Quote>(c.env, tenantOf(c), 'quote');
    const quote = await source.get(c.req.param('id'));
    return quote ? c.json(quote, 200) : c.json({ error: 'not_found' }, 404);
  });

  app.post('/quotes/:id/send', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const parsed = SendQuoteRequest.safeParse(await c.req.json().catch(() => ({})));
    const validDays = (parsed.success ? parsed.data.valid_days : undefined) ?? 14;
    return respond(c, await sendQuote(c.env, tenantOf(c), c.req.param('id'), validDays));
  });

  app.post('/quotes/:id/accept', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    return respond(c, await acceptQuote(c.env, tenantOf(c), c.req.param('id')));
  });

  app.post('/quotes/:id/convert', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    return respond(c, await convertQuote(c.env, tenantOf(c), c.req.param('id')));
  });

  app.get('/invoices/:id', async (c) => {
    const source = await resolveEntitySource<Invoice>(c.env, tenantOf(c), 'invoice');
    const inv = await source.get(c.req.param('id'));
    return inv ? c.json(inv, 200) : c.json({ error: 'not_found' }, 404);
  });

  app.post('/invoices/:id/pay', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    return respond(c, await payInvoice(c.env, tenantOf(c), c.req.param('id')));
  });

  return app;
}
