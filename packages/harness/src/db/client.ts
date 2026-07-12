/**
 * Postgres client factory — the single seam between Felix stores and the
 * database. Connections go through Cloudflare Hyperdrive (`env.HYPERDRIVE`,
 * created with `--caching-disabled` — Felix relies on read-after-write
 * everywhere), which fronts Neon's DIRECT endpoint and owns origin pooling.
 *
 * Lifecycle (current Cloudflare guidance): create the client inside the
 * request, never in module scope, and never call `.end()` — Worker→Hyperdrive
 * connections are torn down with the request while Hyperdrive keeps origin
 * connections warm. `getDb` caches the client on the active RequestContext so
 * every store in one request/cron-tick shares a client; callers without a
 * context (e.g. bare unit tests) just get a fresh one.
 *
 * Hyperdrive pools in transaction mode: no session state (`SET`, advisory
 * locks) survives across queries. Use `sql.begin(...)` for multi-statement
 * atomicity and `SET LOCAL` inside it if a setting is ever needed.
 */

import postgres from 'postgres';
import { getContext } from '../context';
import type { Env } from '../env';

export type Db = postgres.Sql;

export function getDb(env: Env): Db {
  const ctx = getContext();
  if (ctx?.db) return ctx.db;
  const db = postgres(env.HYPERDRIVE.connectionString, {
    // Hyperdrive multiplexes; a small per-invocation cap is the documented sweet spot.
    max: 5,
    // Skip the type-fetch round-trip on connect (we only use built-in types).
    fetch_types: false,
    prepare: true,
    types: {
      // int8 parses to string by default; all Felix bigints are epoch-ms
      // timestamps (far below 2^53), so plain numbers are safe and keep
      // Date.now() arithmetic working at every call site.
      bigint: { to: 20, from: [20], serialize: String, parse: Number },
    },
  });
  if (ctx) ctx.db = db;
  return db;
}
