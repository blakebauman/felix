/**
 * Integration-test setup helpers.
 *
 * Schema management moved out of workerd entirely: the vitest `workers`
 * project's globalSetup (global-setup.ts, Node-side) resets the felix_test
 * database and applies apps/api/migrations with node-pg-migrate before
 * any test file runs. Tests isolate by distinct tenant ids, never by
 * truncating tables.
 */

import {
  buildAnonymousContext,
  disposeContextDb,
  disposeLimitState,
  runWithContext,
} from '@felix/harness/context';
import type { Env as AppEnv } from '@felix/harness/env';

/**
 * Run `fn` under a disposable anonymous RequestContext so `getDb(env)`
 * caches ONE Postgres client for the whole call and closes it afterwards.
 * Use this around direct calls to job/store functions (runAnomalyScan,
 * store CRUD, …) — without it every store call inside creates its own
 * unmanaged client, and the test runner's long-lived context accumulates
 * their connections until the server's max_connections is exhausted
 * (exactly what CI's default-100 Postgres service surfaced).
 */
export async function withPgContext<T>(env: AppEnv, fn: () => Promise<T>): Promise<T> {
  const ctx = buildAnonymousContext(env);
  try {
    return await runWithContext(ctx, fn);
  } finally {
    disposeLimitState(ctx.limitState);
    disposeContextDb(ctx);
  }
}
