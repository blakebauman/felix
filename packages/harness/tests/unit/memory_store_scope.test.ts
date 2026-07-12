/**
 * Regression: semantic-memory recall must be scoped to the calling agent's
 * own memory pool, not just the tenant. Historically recall filtered on the
 * tenant only, so two manifests under the same tenant shared a pool — an
 * internal/admin agent's remembered facts were recallable by a public-facing
 * agent of the same tenant.
 *
 * Pins (against the pgvector store's SQL):
 *   1. `recall` filters on tenant_id AND manifest_id AND the memory kinds
 *      only (procedural/product vectors share the table but must never
 *      surface in semantic recall).
 *   2. `remember` writes the same tenant + manifest scope columns recall
 *      filters on (contract stays symmetric).
 */

import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { getMemoryStore } from '../../src/memory/store';
import { type CapturedQuery, makeFakeSql } from '../helpers/fake-sql';

function ctxForTenant(tenant: string, queries: CapturedQuery[]): RequestContext {
  const { sql } = makeFakeSql((q) => {
    queries.push(q);
    return [];
  });
  const env = {
    AI: {
      // BGE embed stub — return a single 768-length-ish vector.
      async run() {
        return { data: [[0.1, 0.2, 0.3]] };
      },
    },
    HYPERDRIVE: { connectionString: 'postgresql://fake' },
  } as unknown as Env;
  return {
    env,
    auth: { ...ANONYMOUS, principal: { ...ANONYMOUS.principal, tenantId: tenant } },
    limitState: newLimitState(),
    db: sql,
  };
}

describe('PgMemoryStore scoping', () => {
  it('scopes recall to tenant, manifest, and the memory kinds only', async () => {
    const queries: CapturedQuery[] = [];
    const ctx = ctxForTenant('acme', queries);
    const store = getMemoryStore(ctx.env, 'vectorize', 'workerA');
    await runWithContext(ctx, async () => {
      await store.recall('what did I say');
    });
    const q = queries.find((c) => c.text.includes('FROM memory_vectors'));
    expect(q).toBeDefined();
    expect(q!.text).toContain('tenant_id =');
    expect(q!.text).toContain('manifest_id =');
    expect(q!.params).toContain('acme');
    expect(q!.params).toContain('workerA');
    // Kind list keeps procedural/product vectors out of semantic recall.
    expect(q!.params).toEqual(expect.arrayContaining(['fact', 'preference', 'episode']));
    expect(q!.params).not.toContain('procedural');
  });

  it('remember writes the same tenant+manifest scope recall filters on', async () => {
    const queries: CapturedQuery[] = [];
    const ctx = ctxForTenant('acme', queries);
    const store = getMemoryStore(ctx.env, 'vectorize', 'workerA');
    await runWithContext(ctx, async () => {
      await store.remember('a durable fact');
    });
    const q = queries.find((c) => c.text.includes('INSERT INTO memory_vectors'));
    expect(q).toBeDefined();
    expect(q!.params).toContain('acme');
    expect(q!.params).toContain('workerA');
    expect(q!.params).toContain('fact');
  });
});
