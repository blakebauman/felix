/**
 * Consent + attribution read API.
 *
 *   GET /commerce/consents?subject=&limit=        → buyer consent history
 *   GET /commerce/attribution/summary             → orders grouped by channel/manifest
 *   GET /commerce/attribution/orders/:id          → attribution for one order
 *
 * Consent/attribution records are legally sensitive, so reads require the
 * `consent:read` scope. In production (verifiers configured) anonymous callers
 * are rejected; `requireScope`'s dev fallthrough keeps local probes working
 * when no verifiers are set.
 * Mounted under `/commerce` in `app.ts` (alongside the Stripe webhook router).
 */

import { Hono } from 'hono';
import type { AuthContext } from '../auth/context';
import { requireScope } from '../auth/middleware';
import { attributionSummary, getAttribution, listConsents } from '../commerce/consent/store';
import type { Env } from '../env';

type Vars = { Variables: { auth: AuthContext } };

const READ_SCOPE = 'consent:read';

function tenantOf(c: { get: (k: 'auth') => AuthContext }): string {
  return c.get('auth').principal.tenantId;
}

export function buildConsentRouter(): Hono<{ Bindings: Env } & Vars> {
  const app = new Hono<{ Bindings: Env } & Vars>();

  app.get('/consents', async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied;
    const limit = Number.parseInt(c.req.query('limit') ?? '', 10);
    const consents = await listConsents(c.env, tenantOf(c), {
      ...(c.req.query('subject') ? { subject: c.req.query('subject') } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    });
    return c.json({ consents }, 200);
  });

  app.get('/attribution/summary', async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied;
    const summary = await attributionSummary(c.env, tenantOf(c));
    return c.json({ summary }, 200);
  });

  app.get('/attribution/orders/:id', async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied;
    const attribution = await getAttribution(c.env, tenantOf(c), c.req.param('id'));
    if (!attribution) return c.json({ error: 'not_found' }, 404);
    return c.json(attribution, 200);
  });

  return app;
}
