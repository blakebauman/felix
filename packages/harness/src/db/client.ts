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
import {
  buildAnonymousContext,
  disposeContextDb,
  disposeLimitState,
  getContext,
  type RequestContext,
  runWithContext,
} from '../context';
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

/**
 * Client over the OPTIONAL `HYPERDRIVE_CACHED` binding — a second Hyperdrive
 * config with query caching ENABLED (default 60s max_age). Only for public
 * read-only surfaces where staleness is acceptable (storefront pages,
 * structured-data feeds, sitemaps); everything with read-after-write needs
 * stays on the cache-disabled default client. Falls back to `getDb` when the
 * binding isn't configured, so single-binding deployments and local dev/test
 * (one Docker pg) behave identically.
 */
export function getCachedDb(env: Env): Db {
  const ctx = getContext();
  if (ctx?.dbCached) return ctx.dbCached;
  const binding = env.HYPERDRIVE_CACHED;
  if (!binding) return getDb(env);
  const db = postgres(binding.connectionString, {
    max: 5,
    fetch_types: false,
    prepare: true,
    types: {
      bigint: { to: 20, from: [20], serialize: String, parse: Number },
    },
  }) as unknown as Db;
  if (ctx) ctx.dbCached = db;
  return db;
}

/**
 * Run `fn` with the CACHED client as the context's default — every store
 * call inside (they all resolve through `getDb`) transparently reads through
 * the caching config. Writes still work (Hyperdrive only caches non-mutating
 * queries) but read-after-write inside `fn` may see up to `max_age` staleness,
 * so wrap ONLY handlers that are genuinely read-only. The child context
 * shares auth/limits/execCtx with the parent; the cached client itself is
 * closed at request teardown via `disposeContextDb` (parent-cached) or here
 * (contextless callers).
 */
export async function withCachedDb<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  const parent = getContext();
  const cached = getCachedDb(env);
  const base = parent ?? buildAnonymousContext(env);
  const child: RequestContext = { ...base, db: cached };
  try {
    return await runWithContext(child, fn);
  } finally {
    if (!parent) {
      disposeLimitState(base.limitState);
      base.dbCached = cached;
      disposeContextDb(base);
    }
  }
}
