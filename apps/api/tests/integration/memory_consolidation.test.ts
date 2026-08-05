/**
 * Memory-pool discovery against real Postgres.
 *
 * The consolidation sweep finds pools cross-tenant in one query and then does
 * every read and write for a pool under that pool's own tenant. These pin the
 * discovery half — the part that decides whose memory gets touched — because a
 * mis-scoped query here would hand one tenant's facts to another tenant's
 * consolidation pass. The reconciliation logic itself is a model call and is
 * unit-tested with the model stubbed.
 */

import { env } from 'cloudflare:test';
import { listVectorPools, listVectors, upsertVector } from '@felix/harness/db/vectors';
import type { Env as AppEnv } from '@felix/harness/env';
import { runMemoryConsolidation } from '@felix/harness/jobs/memory-consolidation';
import { describe, expect, it } from 'vitest';
import { withPgContext } from './setup';

const testEnv = env as unknown as AppEnv;
const KINDS = ['fact', 'preference', 'episode'] as const;

/** A deterministic 768-dim vector — content doesn't matter for these. */
function embedding(seed: number): number[] {
  return Array.from({ length: 768 }, (_, i) => ((seed + i) % 100) / 100);
}

async function seedFacts(
  tenantId: string,
  manifestId: string,
  texts: string[],
  startAt = 0,
): Promise<void> {
  await withPgContext(testEnv, async () => {
    for (const [i, text] of texts.entries()) {
      await upsertVector(testEnv, {
        tenantId,
        id: `${manifestId}-${startAt + i}`,
        kind: 'fact',
        manifestId,
        values: embedding(i),
        metadata: { text, ts: startAt + i },
      });
    }
  });
}

describe('pool discovery', () => {
  it('reports a pool once it reaches the threshold', async () => {
    const tenant = 'mem-pool-a';
    await seedFacts(tenant, 'agent-a', ['one', 'two', 'three']);

    const atTwo = await withPgContext(testEnv, () => listVectorPools(testEnv, KINDS, 2, 50));
    const mine = atTwo.find((p) => p.tenant_id === tenant && p.manifest_id === 'agent-a');
    expect(mine?.count).toBe(3);

    const atTen = await withPgContext(testEnv, () => listVectorPools(testEnv, KINDS, 10, 50));
    expect(atTen.find((p) => p.tenant_id === tenant)).toBeUndefined();
  });

  it('keeps each tenant and manifest in its own pool', async () => {
    // The sweep scans cross-tenant, so pools must never be merged by manifest
    // name alone — two tenants running the same manifest are separate memories.
    await seedFacts('mem-pool-b1', 'shared-name', ['b1-one', 'b1-two']);
    await seedFacts('mem-pool-b2', 'shared-name', ['b2-one', 'b2-two', 'b2-three']);

    const pools = await withPgContext(testEnv, () => listVectorPools(testEnv, KINDS, 2, 100));
    const b1 = pools.find((p) => p.tenant_id === 'mem-pool-b1' && p.manifest_id === 'shared-name');
    const b2 = pools.find((p) => p.tenant_id === 'mem-pool-b2' && p.manifest_id === 'shared-name');
    expect(b1?.count).toBe(2);
    expect(b2?.count).toBe(3);
  });

  it('skips rows with no owning manifest', async () => {
    // Product and image vectors share the table with an empty manifest_id and
    // are not agent memory.
    await withPgContext(testEnv, () =>
      upsertVector(testEnv, {
        tenantId: 'mem-pool-c',
        id: 'product-1',
        kind: 'product',
        manifestId: '',
        values: embedding(1),
        metadata: { text: 'a product' },
      }),
    );
    const pools = await withPgContext(testEnv, () => listVectorPools(testEnv, KINDS, 1, 100));
    expect(pools.find((p) => p.tenant_id === 'mem-pool-c')).toBeUndefined();
  });
});

describe('listVectors', () => {
  it('returns a tenant+manifest pool oldest first', async () => {
    const tenant = 'mem-list-a';
    await seedFacts(tenant, 'agent-l', ['first', 'second', 'third']);
    const rows = await withPgContext(testEnv, () =>
      listVectors(testEnv, { tenantId: tenant, kinds: KINDS, manifestId: 'agent-l', limit: 10 }),
    );
    // Oldest first is what makes "this was later corrected" legible to the
    // model reading the numbered list.
    expect(rows.map((r) => r.metadata.text)).toEqual(['first', 'second', 'third']);
  });

  it('does not return another tenant rows', async () => {
    await seedFacts('mem-list-b1', 'agent-x', ['mine']);
    await seedFacts('mem-list-b2', 'agent-x', ['theirs']);
    const rows = await withPgContext(testEnv, () =>
      listVectors(testEnv, {
        tenantId: 'mem-list-b1',
        kinds: KINDS,
        manifestId: 'agent-x',
        limit: 10,
      }),
    );
    expect(rows.map((r) => r.metadata.text)).toEqual(['mine']);
  });

  it('honors the limit so an oversized pool is consolidated across sweeps', async () => {
    const tenant = 'mem-list-c';
    await seedFacts(
      tenant,
      'agent-big',
      Array.from({ length: 8 }, (_, i) => `fact ${i}`),
    );
    const rows = await withPgContext(testEnv, () =>
      listVectors(testEnv, { tenantId: tenant, kinds: KINDS, manifestId: 'agent-big', limit: 3 }),
    );
    expect(rows).toHaveLength(3);
  });
});

describe('the sweep', () => {
  it('is a no-op when no manifest resolves for a discovered pool', async () => {
    // A pool whose manifest was deleted must not throw or touch the rows.
    const tenant = 'mem-sweep-a';
    await seedFacts(
      tenant,
      'no-such-manifest',
      Array.from({ length: 12 }, (_, i) => `fact ${i}`),
    );

    await withPgContext(testEnv, () => runMemoryConsolidation(testEnv, Date.now()));

    const rows = await withPgContext(testEnv, () =>
      listVectors(testEnv, {
        tenantId: tenant,
        kinds: KINDS,
        manifestId: 'no-such-manifest',
        limit: 50,
      }),
    );
    expect(rows).toHaveLength(12);
  });
});
