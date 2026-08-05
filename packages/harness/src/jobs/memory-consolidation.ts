/**
 * Cron sweep that reconciles memory pools.
 *
 * Consolidation is per-manifest work with no request to hang it off, so it
 * runs here. The sweep finds pools big enough to be worth a model call, reads
 * each owning manifest's config, and consolidates under a context scoped to
 * that pool's tenant.
 *
 * The tenant scoping is the part that has to be right: pools are discovered
 * cross-tenant in one indexed query, but every read and write for a pool then
 * happens under that pool's own tenant, because the anonymous cron identity is
 * tenant `default` and a mis-scoped write here would move one tenant's
 * memories into another's.
 */

import {
  buildBackgroundContext,
  disposeContextDb,
  disposeLimitState,
  runWithContext,
} from '../context';
import { listVectorPools, listVectors } from '../db/vectors';
import type { Env } from '../env';
import { resolveManifest } from '../manifests/resolver';
import { type ConsolidateConfig, consolidatePool } from '../memory/consolidate';
import { getMemoryStore, MEMORY_KINDS, type MemoryRecord } from '../memory/store';
import { recordCounter } from '../observability/metrics';

/**
 * Pools consolidated per tick. Each is a model call over up to `max_facts`
 * entries, and the tick shares its budget with every other scheduled task, so
 * this stays small; pools not reached keep their size and are picked up next
 * tick, since eligibility is recomputed from scratch each time.
 */
const MAX_POOLS_PER_TICK = 3;

/**
 * Floor the discovery query scans at. It has to pick a threshold before it
 * knows whose pools these are, so it uses the lowest any manifest can
 * configure — the schema enforces the same minimum on `after_facts`, which is
 * what makes this safe — and each pool is re-checked against its own
 * manifest's setting once that is known.
 */
export const DISCOVERY_MIN_FACTS = 10;

export async function runMemoryConsolidation(
  env: Env,
  at: number = Date.now(),
  execCtx?: ExecutionContext,
): Promise<void> {
  void at;
  const pools = await listVectorPools(
    env,
    MEMORY_KINDS,
    DISCOVERY_MIN_FACTS,
    MAX_POOLS_PER_TICK * 4,
  );
  let done = 0;

  for (const pool of pools) {
    if (done >= MAX_POOLS_PER_TICK) {
      recordCounter('orchestrator_memory_consolidate_deferred', { manifest_id: pool.manifest_id });
      continue;
    }

    const ctx = buildBackgroundContext(env, {
      tenantId: pool.tenant_id,
      subject: `memory-consolidation:${pool.manifest_id}`,
      execCtx,
    });
    try {
      const ran = await runWithContext(ctx, async () => {
        const resolved = await resolveManifest(env, pool.tenant_id, pool.manifest_id);
        if (!resolved) return false;
        const config = resolved.manifest.spec.memory.consolidate as ConsolidateConfig;
        // Re-check against the manifest's OWN threshold: discovery scanned at
        // the most permissive value it could, not this manifest's.
        if (!config?.enabled || pool.count < config.after_facts) return false;

        const rows = await listVectors(env, {
          tenantId: pool.tenant_id,
          kinds: MEMORY_KINDS,
          manifestId: pool.manifest_id,
          limit: config.max_facts,
        });
        const facts: MemoryRecord[] = rows.map((r) => ({
          id: r.id,
          text: String(r.metadata.text ?? ''),
          tenant: pool.tenant_id,
          manifest: r.manifest_id,
          kind: (r.kind as MemoryRecord['kind']) ?? 'fact',
          ts: Number(r.metadata.ts ?? r.created_at ?? 0),
        }));
        // A row whose metadata lost its text can't be reasoned about, and
        // including it would shift every later index in the numbered list.
        const usable = facts.filter((f) => f.text.trim().length > 0);
        if (usable.length === 0) return false;

        const store = getMemoryStore(env, resolved.manifest.spec.memory.store, pool.manifest_id);
        await consolidatePool(env, config, store, usable, pool.manifest_id);
        return true;
      });
      if (ran) done += 1;
    } catch (err) {
      // One tenant's bad pool must not stop the others.
      console.error(`memory consolidation failed for ${pool.tenant_id}/${pool.manifest_id}`, err);
      recordCounter('orchestrator_memory_consolidate_errors', { manifest_id: pool.manifest_id });
    } finally {
      disposeLimitState(ctx.limitState);
      disposeContextDb(ctx);
    }
  }
}
