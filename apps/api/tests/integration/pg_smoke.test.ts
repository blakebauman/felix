/**
 * Hyperdrive → Postgres smoke test: proves the binding round-trips through
 * miniflare's hyperdrive emulation with postgres.js in workerd, and that
 * global-setup applied the baseline schema (tables + extensions). The store
 * cutover PRs build on this seam.
 */

import { env } from 'cloudflare:test';
import { getDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';
import { describe, expect, it } from 'vitest';

describe('postgres via hyperdrive', () => {
  it('round-trips a query through the HYPERDRIVE binding', async () => {
    const sql = getDb(env as unknown as Env);
    const rows = await sql`SELECT 1 + 1 AS two`;
    expect(rows[0]?.two).toBe(2);
  });

  it('sees the migrated baseline schema', async () => {
    const sql = getDb(env as unknown as Env);
    const audit = await sql`SELECT count(*)::int AS n FROM audit_events`;
    expect(audit[0]?.n).toBeGreaterThanOrEqual(0);
    const exts = await sql`
      SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm') ORDER BY extname
    `;
    expect(exts.map((e) => e.extname)).toEqual(['pg_trgm', 'vector']);
  });

  it('parses bigint columns as numbers (epoch-ms convention)', async () => {
    const sql = getDb(env as unknown as Env);
    const now = Date.now();
    await sql`
      INSERT INTO audit_events (id, tenant_id, ts, event_type)
      VALUES ('pg-smoke-1', 'pg-smoke-tenant', ${now}, 'smoke')
      ON CONFLICT (tenant_id, id) DO UPDATE SET ts = excluded.ts
    `;
    const rows = await sql`
      SELECT ts FROM audit_events WHERE tenant_id = 'pg-smoke-tenant' AND id = 'pg-smoke-1'
    `;
    expect(typeof rows[0]?.ts).toBe('number');
    expect(rows[0]?.ts).toBe(now);
  });
});

describe('cached-reads binding (HYPERDRIVE_CACHED)', () => {
  it('round-trips through the second hyperdrive binding', async () => {
    const { getCachedDb } = await import('@felix/harness/db/client');
    const sql = getCachedDb(env as unknown as Env);
    const rows = await sql`SELECT 2 + 2 AS four`;
    expect(rows[0]?.four).toBe(4);
  });
});
