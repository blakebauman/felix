/**
 * pgvector-backed vector store over the `memory_vectors` table — the single
 * home for every 768-dim BGE embedding the harness and plugins keep:
 * semantic memory (`fact` / `preference` / `episode`), procedural memory
 * (`procedural`), and the commerce catalog embeddings (`product` /
 * `product_image`). Replaces the Vectorize `MEMORY_VEC` index.
 *
 * Scope filters that used to be Vectorize metadata are real columns
 * (`tenant_id`, `kind`, `manifest_id`) — every query REQUIRES a tenant and
 * an explicit kind list, so the kinds can never bleed into each other the
 * way ad-hoc metadata filters allowed. Similarity is cosine via the HNSW
 * index (`embedding <=> $q`); `score = 1 - distance` preserves the
 * Vectorize score shape (1 = identical).
 *
 * HNSW post-filters WHERE clauses, so heavily-filtered queries can return
 * fewer than topK rows for tiny tenants — acceptable at Felix scale.
 * Never `SET hnsw.*` at the session level (Hyperdrive pools in transaction
 * mode); if ever needed, `SET LOCAL` inside `sql.begin`.
 */

import type { Env } from '../env';
import { getDb } from './client';

export interface VectorUpsert {
  tenantId: string;
  id: string;
  kind: string;
  /** Empty string for vectors not owned by a manifest (products, images). */
  manifestId?: string;
  values: readonly number[];
  metadata?: Record<string, unknown>;
}

export interface VectorMatch {
  id: string;
  kind: string;
  manifest_id: string;
  metadata: Record<string, unknown>;
  created_at: number;
  /** Cosine similarity, 1 = identical (Vectorize-compatible shape). */
  score: number;
}

export interface VectorQuery {
  tenantId: string;
  /** Kinds to search — explicit so pools never bleed into each other. */
  kinds: readonly string[];
  /** When set, restrict to one manifest's pool (per-agent memory boundary). */
  manifestId?: string;
  values: readonly number[];
  topK: number;
}

/** pgvector input literal: `[0.1,0.2,...]`, cast with `::vector` in SQL. */
function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

export async function upsertVector(env: Env, row: VectorUpsert): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO memory_vectors (tenant_id, id, kind, manifest_id, embedding, metadata, created_at)
      VALUES (${row.tenantId}, ${row.id}, ${row.kind}, ${row.manifestId ?? ''},
              ${vectorLiteral(row.values)}::vector, ${row.metadata ?? {}}, ${Date.now()})
      ON CONFLICT (tenant_id, id) DO UPDATE SET
        kind = excluded.kind,
        manifest_id = excluded.manifest_id,
        embedding = excluded.embedding,
        metadata = excluded.metadata,
        created_at = excluded.created_at
  `;
}

export async function queryVectors(env: Env, q: VectorQuery): Promise<VectorMatch[]> {
  if (q.values.length === 0 || q.kinds.length === 0) return [];
  const sql = getDb(env);
  const literal = vectorLiteral(q.values);
  const rows = await sql<
    {
      id: string;
      kind: string;
      manifest_id: string;
      metadata: Record<string, unknown>;
      created_at: number;
      score: number;
    }[]
  >`
    SELECT id, kind, manifest_id, metadata, created_at,
           1 - (embedding <=> ${literal}::vector) AS score
      FROM memory_vectors
      WHERE tenant_id = ${q.tenantId} AND kind IN ${sql([...q.kinds])}
        ${q.manifestId !== undefined ? sql`AND manifest_id = ${q.manifestId}` : sql``}
      ORDER BY embedding <=> ${literal}::vector
      LIMIT ${Math.max(1, q.topK)}
  `;
  return rows.map((r) => ({ ...r, metadata: r.metadata ?? {} }));
}

/**
 * Read one vector's stored embedding back (e.g. to reuse a product's vector
 * as a similarity seed). Tenant-scoped; null when absent.
 */
export async function getVectorValues(
  env: Env,
  tenantId: string,
  id: string,
): Promise<number[] | null> {
  const sql = getDb(env);
  const rows = await sql<{ embedding: string }[]>`
    SELECT embedding::text AS embedding FROM memory_vectors
      WHERE tenant_id = ${tenantId} AND id = ${id} LIMIT 1
  `;
  const text = rows[0]?.embedding;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as number[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Tenant-scoped delete. The WHERE clause is the cross-tenant guard — a
 * caller can only ever erase its own tenant's vector, no lookup dance
 * needed (the old Vectorize path had to getByIds + check metadata).
 * Returns true when a row was deleted.
 */
export async function deleteVector(env: Env, tenantId: string, id: string): Promise<boolean> {
  const sql = getDb(env);
  const res = await sql`
    DELETE FROM memory_vectors WHERE tenant_id = ${tenantId} AND id = ${id}
  `;
  return res.count > 0;
}
