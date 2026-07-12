/**
 * Regression: Vectorize semantic-memory recall must be scoped to the calling
 * agent's own memory pool, not just the tenant. Upsert stores
 * `{ tenant, manifest, kind }` metadata; recall previously filtered on
 * `{ tenant }` only, so two manifests under the same tenant shared a pool —
 * an internal/admin agent's remembered facts were recallable by a
 * public-facing agent of the same tenant.
 *
 * Pins:
 *   1. `recall` passes `manifest` (the store's manifestId) in the Vectorize
 *      query filter alongside `tenant`.
 *   2. `remember` upserts the same `{ tenant, manifest }` metadata it filters
 *      recall on (contract stays symmetric).
 */

import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { getMemoryStore } from '../../src/memory/store';

function ctxForTenant(
  tenant: string,
  capture: { query?: unknown; upsert?: unknown },
): RequestContext {
  const env = {
    AI: {
      // BGE embed stub — return a single 768-length-ish vector.
      async run() {
        return { data: [[0.1, 0.2, 0.3]] };
      },
    },
    MEMORY_VEC: {
      async query(_values: number[], opts: unknown) {
        capture.query = opts;
        return { matches: [] };
      },
      async upsert(vectors: unknown) {
        capture.upsert = vectors;
      },
    },
  } as unknown as Env;
  return {
    env,
    auth: { ...ANONYMOUS, principal: { ...ANONYMOUS.principal, tenantId: tenant } },
    limitState: newLimitState(),
  };
}

describe('VectorizeMemoryStore scoping', () => {
  it('scopes recall to both tenant and manifest', async () => {
    const capture: { query?: unknown } = {};
    const ctx = ctxForTenant('acme', capture);
    const store = getMemoryStore(ctx.env, 'vectorize', 'workerA');
    await runWithContext(ctx, async () => {
      await store.recall('what did I say');
    });
    const opts = capture.query as { filter?: Record<string, unknown> };
    expect(opts.filter).toMatchObject({ tenant: 'acme', manifest: 'workerA' });
  });

  it('upsert stores the same tenant+manifest metadata recall filters on', async () => {
    const capture: { upsert?: unknown } = {};
    const ctx = ctxForTenant('acme', capture);
    const store = getMemoryStore(ctx.env, 'vectorize', 'workerA');
    await runWithContext(ctx, async () => {
      await store.remember('a durable fact');
    });
    const vectors = capture.upsert as Array<{ metadata: Record<string, unknown> }>;
    expect(vectors[0]!.metadata).toMatchObject({ tenant: 'acme', manifest: 'workerA' });
  });
});
