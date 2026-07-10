/**
 * GEO / AEO monitoring management + read API.
 *
 *   POST   /geo/queries            → register a tracked query (geo:write)
 *   GET    /geo/queries            → list tracked queries
 *   DELETE /geo/queries/:id        → remove a tracked query (geo:write)
 *   GET    /geo/observations       → list observations (?brand= &query= &limit=)
 *   GET    /geo/summary            → latest rank per query (the "where do we rank" view)
 *
 * Operator-scoped: mutations require `geo:write`; reads are tenant-scoped and
 * need no scope (dev falls open), matching the B2B router convention.
 */

import { Hono } from 'hono';
import type { AuthContext } from '../auth/context';
import { requireScope } from '../auth/middleware';
import type { Env } from '../env';
import { CreateGeoQueryRequest, type GeoQuery } from '../geo/models';
import { deleteQuery, listObservations, listQueries, upsertQuery } from '../geo/store';

const WRITE_SCOPE = 'geo:write';
type Vars = { Variables: { auth: AuthContext } };

function tenantOf(c: { get: (k: 'auth') => AuthContext }): string {
  return c.get('auth').principal.tenantId;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'q'
  );
}

export function buildGeoRouter(): Hono<{ Bindings: Env } & Vars> {
  const app = new Hono<{ Bindings: Env } & Vars>();

  app.post('/queries', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const parsed = CreateGeoQueryRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
    const tenant = tenantOf(c);
    const id =
      parsed.data.id ?? `${slugify(parsed.data.query_text)}-${crypto.randomUUID().slice(0, 8)}`;
    const query: GeoQuery = {
      tenant_id: tenant,
      id,
      brand_id: parsed.data.brand_id ?? '',
      query_text: parsed.data.query_text,
      engine: parsed.data.engine ?? 'workers_ai',
      active: true,
      created_at: Date.now(),
    };
    await upsertQuery(c.env, query);
    return c.json(query, 201);
  });

  app.get('/queries', async (c) => {
    const queries = await listQueries(c.env, tenantOf(c));
    return c.json({ queries }, 200);
  });

  app.delete('/queries/:id', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const ok = await deleteQuery(c.env, tenantOf(c), c.req.param('id'));
    return c.json({ deleted: ok }, ok ? 200 : 404);
  });

  app.get('/observations', async (c) => {
    const limit = Number.parseInt(c.req.query('limit') ?? '', 10);
    const observations = await listObservations(c.env, tenantOf(c), {
      ...(c.req.query('brand') ? { brandId: c.req.query('brand') } : {}),
      ...(c.req.query('query') ? { queryId: c.req.query('query') } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    });
    return c.json({ observations }, 200);
  });

  // Latest observation per tracked query — the at-a-glance ranking board.
  app.get('/summary', async (c) => {
    const tenant = tenantOf(c);
    const queries = await listQueries(c.env, tenant);
    const rows = await Promise.all(
      queries.map(async (q) => {
        const [latest] = await listObservations(c.env, tenant, { queryId: q.id, limit: 1 });
        return {
          query_id: q.id,
          query_text: q.query_text,
          brand_id: q.brand_id,
          active: q.active,
          latest: latest
            ? {
                ts: latest.ts,
                brand_mentioned: latest.brand_mentioned,
                rank: latest.rank,
                competitors: latest.competitors,
              }
            : null,
        };
      }),
    );
    return c.json({ summary: rows }, 200);
  });

  return app;
}
