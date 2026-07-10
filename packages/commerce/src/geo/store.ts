/**
 * GEO monitoring store (D1). Tenant-scoped like the rest of the schema; the
 * cron-facing `listActiveQueries` deliberately reads across tenants (the cron
 * has no single tenant), mirroring `listActiveCanaries`.
 */

import type { Env } from '@felix/orchestrator/env';
import {
  type GeoObservation,
  GeoObservation as GeoObservationSchema,
  type GeoQuery,
} from './models';

interface QueryRow {
  tenant_id: string;
  id: string;
  brand_id: string;
  query_text: string;
  engine: string;
  active: number;
  created_at: number;
}

function rowToQuery(row: QueryRow): GeoQuery {
  return {
    tenant_id: row.tenant_id,
    id: row.id,
    brand_id: row.brand_id,
    query_text: row.query_text,
    engine: row.engine === 'openai' || row.engine === 'anthropic' ? row.engine : 'workers_ai',
    active: row.active === 1,
    created_at: row.created_at,
  };
}

export async function upsertQuery(env: Env, q: GeoQuery): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO geo_queries (tenant_id, id, brand_id, query_text, engine, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       brand_id = excluded.brand_id,
       query_text = excluded.query_text,
       engine = excluded.engine,
       active = excluded.active`,
  )
    .bind(q.tenant_id, q.id, q.brand_id, q.query_text, q.engine, q.active ? 1 : 0, q.created_at)
    .run();
}

export async function getQuery(env: Env, tenantId: string, id: string): Promise<GeoQuery | null> {
  const row = await env.DB.prepare(
    'SELECT * FROM geo_queries WHERE tenant_id = ? AND id = ? LIMIT 1',
  )
    .bind(tenantId, id)
    .first<QueryRow>();
  return row ? rowToQuery(row) : null;
}

export async function listQueries(env: Env, tenantId: string): Promise<GeoQuery[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM geo_queries WHERE tenant_id = ? ORDER BY created_at DESC',
  )
    .bind(tenantId)
    .all<QueryRow>();
  return (rows.results ?? []).map(rowToQuery);
}

export async function deleteQuery(env: Env, tenantId: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM geo_queries WHERE tenant_id = ? AND id = ?')
    .bind(tenantId, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** All active queries across tenants, capped — the cron work list. */
export async function listActiveQueries(env: Env, limit: number): Promise<GeoQuery[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM geo_queries WHERE active = 1 ORDER BY created_at ASC LIMIT ?',
  )
    .bind(Math.max(1, limit))
    .all<QueryRow>();
  return (rows.results ?? []).map(rowToQuery);
}

export async function putObservation(env: Env, obs: GeoObservation): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO geo_observations
        (tenant_id, id, query_id, brand_id, engine, ts, brand_mentioned, rank,
         competitors_json, products_json, answer_excerpt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      obs.tenant_id,
      obs.id,
      obs.query_id,
      obs.brand_id,
      obs.engine,
      obs.ts,
      obs.brand_mentioned ? 1 : 0,
      obs.rank,
      JSON.stringify(obs.competitors),
      JSON.stringify(obs.products),
      obs.answer_excerpt,
    )
    .run();
}

interface ObsRow {
  tenant_id: string;
  id: string;
  query_id: string;
  brand_id: string;
  engine: string;
  ts: number;
  brand_mentioned: number;
  rank: number;
  competitors_json: string;
  products_json: string;
  answer_excerpt: string;
}

function safeArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rowToObs(row: ObsRow): GeoObservation {
  return GeoObservationSchema.parse({
    tenant_id: row.tenant_id,
    id: row.id,
    query_id: row.query_id,
    brand_id: row.brand_id,
    engine: row.engine,
    ts: row.ts,
    brand_mentioned: row.brand_mentioned === 1,
    rank: row.rank,
    competitors: safeArray(row.competitors_json),
    products: safeArray(row.products_json),
    answer_excerpt: row.answer_excerpt,
  });
}

export interface ListObsOpts {
  brandId?: string;
  queryId?: string;
  limit?: number;
}

export async function listObservations(
  env: Env,
  tenantId: string,
  opts: ListObsOpts = {},
): Promise<GeoObservation[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const clauses = ['tenant_id = ?'];
  const binds: unknown[] = [tenantId];
  if (opts.queryId) {
    clauses.push('query_id = ?');
    binds.push(opts.queryId);
  }
  if (opts.brandId) {
    clauses.push('brand_id = ?');
    binds.push(opts.brandId);
  }
  const rows = await env.DB.prepare(
    `SELECT * FROM geo_observations WHERE ${clauses.join(' AND ')} ORDER BY ts DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<ObsRow>();
  return (rows.results ?? []).map(rowToObs);
}
