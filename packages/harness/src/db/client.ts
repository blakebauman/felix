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

/**
 * Custom-type map for the Felix client. `bigint` is a real runtime parser
 * (int8 → Number); `json` exists only at the TYPE level so tagged-template
 * params accept plain objects/arrays for jsonb columns — postgres.js
 * Describes each statement, sees the jsonb param OID, and JSON-serializes
 * the value once (pre-stringifying would double-encode into a jsonb string
 * scalar).
 */
type FelixDbTypes = {
  bigint: number;
  json: Record<string, unknown> | readonly unknown[];
};

export type Db = postgres.Sql<FelixDbTypes>;

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
    // Cast: `json` in FelixDbTypes is type-level only (no runtime parser
    // needed — postgres.js parses json/jsonb natively).
  }) as unknown as Db;
  if (ctx) ctx.db = db;
  return db;
}
