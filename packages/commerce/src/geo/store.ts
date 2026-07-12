/**
 * GEO monitoring store (Postgres). Tenant-scoped like the rest of the schema;
 * the cron-facing `listActiveQueries` deliberately reads across tenants (the
 * cron has no single tenant), mirroring `listActiveCanaries`.
 */

import { getDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';
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
  active: boolean;
  created_at: number;
}

function rowToQuery(row: QueryRow): GeoQuery {
  return {
    tenant_id: row.tenant_id,
    id: row.id,
    brand_id: row.brand_id,
    query_text: row.query_text,
    engine: row.engine === 'openai' || row.engine === 'anthropic' ? row.engine : 'workers_ai',
    active: row.active,
    created_at: row.created_at,
  };
}

export async function upsertQuery(env: Env, q: GeoQuery): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO geo_queries (tenant_id, id, brand_id, query_text, engine, active, created_at)
      VALUES (${q.tenant_id}, ${q.id}, ${q.brand_id}, ${q.query_text}, ${q.engine},
              ${q.active}, ${q.created_at})
      ON CONFLICT (tenant_id, id) DO UPDATE SET
        brand_id = excluded.brand_id,
        query_text = excluded.query_text,
        engine = excluded.engine,
        active = excluded.active
  `;
}

export async function getQuery(env: Env, tenantId: string, id: string): Promise<GeoQuery | null> {
  const sql = getDb(env);
  const rows = await sql<QueryRow[]>`
    SELECT * FROM geo_queries WHERE tenant_id = ${tenantId} AND id = ${id} LIMIT 1
  `;
  return rows[0] ? rowToQuery(rows[0]) : null;
}

export async function listQueries(env: Env, tenantId: string): Promise<GeoQuery[]> {
  const sql = getDb(env);
  const rows = await sql<QueryRow[]>`
    SELECT * FROM geo_queries WHERE tenant_id = ${tenantId} ORDER BY created_at DESC
  `;
  return rows.map(rowToQuery);
}

export async function deleteQuery(env: Env, tenantId: string, id: string): Promise<boolean> {
  const sql = getDb(env);
  const res = await sql`
    DELETE FROM geo_queries WHERE tenant_id = ${tenantId} AND id = ${id}
  `;
  return res.count > 0;
}

/** All active queries across tenants, capped — the cron work list. */
export async function listActiveQueries(env: Env, limit: number): Promise<GeoQuery[]> {
  const sql = getDb(env);
  const rows = await sql<QueryRow[]>`
    SELECT * FROM geo_queries WHERE active = true ORDER BY created_at ASC
      LIMIT ${Math.max(1, limit)}
  `;
  return rows.map(rowToQuery);
}

export async function putObservation(env: Env, obs: GeoObservation): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO geo_observations
        (tenant_id, id, query_id, brand_id, engine, ts, brand_mentioned, rank,
         competitors_json, products_json, answer_excerpt)
      VALUES (${obs.tenant_id}, ${obs.id}, ${obs.query_id}, ${obs.brand_id}, ${obs.engine},
              ${obs.ts}, ${obs.brand_mentioned}, ${obs.rank},
              ${obs.competitors as readonly unknown[]}, ${obs.products as readonly unknown[]},
              ${obs.answer_excerpt})
  `;
}

interface ObsRow {
  tenant_id: string;
  id: string;
  query_id: string;
  brand_id: string;
  engine: string;
  ts: number;
  brand_mentioned: boolean;
  rank: number;
  competitors_json: unknown;
  products_json: unknown;
  answer_excerpt: string;
}

function safeArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function rowToObs(row: ObsRow): GeoObservation {
  return GeoObservationSchema.parse({
    tenant_id: row.tenant_id,
    id: row.id,
    query_id: row.query_id,
    brand_id: row.brand_id,
    engine: row.engine,
    ts: row.ts,
    brand_mentioned: row.brand_mentioned,
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
  const sql = getDb(env);
  const rows = await sql<ObsRow[]>`
    SELECT * FROM geo_observations
      WHERE tenant_id = ${tenantId}
      ${opts.queryId ? sql`AND query_id = ${opts.queryId}` : sql``}
      ${opts.brandId ? sql`AND brand_id = ${opts.brandId}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
  `;
  return rows.map(rowToObs);
}
