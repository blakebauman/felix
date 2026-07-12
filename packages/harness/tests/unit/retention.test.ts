/**
 * Retention-sweep unit tests.
 *
 * Pins the GC contract: `runRetentionSweep` prunes audit_events older than
 * the retention window and expired plans, in BOUNDED batches, while
 * retaining recent rows — and emits an observable summary. The DB is stubbed
 * as an in-memory model so the test stays decoupled from Postgres.
 */

import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../src/audit/models';
import type { Env } from '../../src/env';
import {
  DEFAULT_ARTIFACT_RETENTION_DAYS,
  DEFAULT_AUDIT_RETENTION_DAYS,
  parseArtifactRetentionDays,
  parseAuditRetentionDays,
  runRetentionSweep,
} from '../../src/jobs/retention';
import { makeFakeSql, withFakeDb } from '../helpers/fake-sql';

const DAY_MS = 24 * 60 * 60 * 1000;

interface AuditRow {
  ts: number;
}
interface PlanRow {
  expires_at: number | null;
}

/**
 * In-memory Postgres stub that understands only the two bounded-delete
 * queries the sweep issues. It applies the cutoff + LIMIT params to the
 * in-memory rows, deletes up to LIMIT matching rows, and reports the
 * deleted count (mirrors a real DELETE result's `.count`).
 */
function fakeEnv(audit: AuditRow[], plans: PlanRow[], sink: AuditEvent[]) {
  const { sql } = makeFakeSql((q) => {
    const isAudit = q.text.includes('audit_events');
    const [cutoff, limit] = q.params as [number, number];
    let changes = 0;
    if (isAudit) {
      const survivors: AuditRow[] = [];
      for (const r of audit) {
        if (r.ts < cutoff && changes < limit) changes += 1;
        else survivors.push(r);
      }
      audit.length = 0;
      audit.push(...survivors);
    } else {
      const survivors: PlanRow[] = [];
      for (const r of plans) {
        if (r.expires_at !== null && r.expires_at < cutoff && changes < limit) changes += 1;
        else survivors.push(r);
      }
      plans.length = 0;
      plans.push(...survivors);
    }
    return changes;
  });
  const env = {
    HYPERDRIVE: { connectionString: 'postgresql://fake' },
    AUDIT_QUEUE: {
      send: (e: AuditEvent) => {
        sink.push(e);
        return Promise.resolve();
      },
    },
  } as unknown as Env;
  return { env, sql };
}

describe('runRetentionSweep', () => {
  const NOW = 1_000_000_000_000;

  it('deletes old audit rows + expired plans and retains recent ones', async () => {
    const oldTs = NOW - 100 * DAY_MS; // older than default 90d window
    const recentTs = NOW - 10 * DAY_MS; // within window
    const audit: AuditRow[] = [{ ts: oldTs }, { ts: oldTs }, { ts: recentTs }];
    const plans: PlanRow[] = [
      { expires_at: NOW - DAY_MS }, // expired
      { expires_at: NOW + DAY_MS }, // still valid
      { expires_at: null }, // no TTL — never pruned
    ];
    const sink: AuditEvent[] = [];

    const { env, sql } = fakeEnv(audit, plans, sink);
    const result = await withFakeDb(env, sql, () => runRetentionSweep(env, NOW));

    expect(result.audit_deleted).toBe(2);
    expect(result.plans_deleted).toBe(1);
    expect(result.errors).toEqual([]);
    // Recent audit row + valid/null-TTL plans survive.
    expect(audit).toEqual([{ ts: recentTs }]);
    expect(plans).toEqual([{ expires_at: NOW + DAY_MS }, { expires_at: null }]);

    // Summary audit event is emitted.
    const summary = sink.find((e) => e.event_type === 'retention_sweep');
    expect(summary).toBeDefined();
    expect(summary?.status).toBe('ok');
    expect(summary?.payload.audit_deleted).toBe(2);
    expect(summary?.payload.plans_deleted).toBe(1);
    expect(summary?.payload.audit_retention_days).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
  });

  it('respects the per-tick batch cap (5000) and flags capped', async () => {
    const oldTs = NOW - 200 * DAY_MS;
    // 5001 deletable rows — one over the cap.
    const audit: AuditRow[] = Array.from({ length: 5001 }, () => ({ ts: oldTs }));
    const sink: AuditEvent[] = [];

    const { env, sql } = fakeEnv(audit, [], sink);
    const result = await withFakeDb(env, sql, () => runRetentionSweep(env, NOW));

    expect(result.audit_deleted).toBe(5000);
    expect(result.audit_capped).toBe(true);
    // One row remains for the next tick.
    expect(audit).toHaveLength(1);
  });

  it('is a no-op with no DB or R2 binding', async () => {
    const result = await runRetentionSweep({} as unknown as Env, NOW);
    expect(result).toEqual({
      audit_deleted: 0,
      plans_deleted: 0,
      artifacts_deleted: 0,
      memory_deleted: 0,
      audit_capped: false,
      plans_capped: false,
      artifacts_capped: false,
      memory_capped: false,
      errors: [],
    });
  });

  it('parseAuditRetentionDays — default, override, clamp, and bad input', () => {
    const env = (v?: string) => ({ AUDIT_RETENTION_DAYS: v }) as unknown as Env;
    expect(parseAuditRetentionDays(env())).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(parseAuditRetentionDays(env(''))).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(parseAuditRetentionDays(env('not-a-number'))).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(parseAuditRetentionDays(env('30'))).toBe(30);
    // Clamp: below floor (7) and above ceiling (3650).
    expect(parseAuditRetentionDays(env('1'))).toBe(7);
    expect(parseAuditRetentionDays(env('999999'))).toBe(3650);
    // Fractional floored.
    expect(parseAuditRetentionDays(env('45.9'))).toBe(45);
  });

  it('parseArtifactRetentionDays — default, override, clamp, and bad input', () => {
    const env = (v?: string) => ({ ARTIFACT_RETENTION_DAYS: v }) as unknown as Env;
    expect(parseArtifactRetentionDays(env())).toBe(DEFAULT_ARTIFACT_RETENTION_DAYS);
    expect(parseArtifactRetentionDays(env('not-a-number'))).toBe(DEFAULT_ARTIFACT_RETENTION_DAYS);
    expect(parseArtifactRetentionDays(env('14'))).toBe(14);
    // Clamp: below floor (1) and above ceiling (3650).
    expect(parseArtifactRetentionDays(env('0'))).toBe(1);
    expect(parseArtifactRetentionDays(env('999999'))).toBe(3650);
  });
});

interface FakeR2Object {
  key: string;
  uploaded: Date;
}

/**
 * Minimal R2 bucket stub understanding the `list` (prefix + cursor + limit) and
 * `delete` (array of keys) calls the artifact sweep issues. Paginates so the
 * per-tick page/delete caps can be exercised.
 */
function fakeBundles(objects: FakeR2Object[], pageSize: number, deleted: string[]) {
  return {
    async list(opts: { prefix?: string; cursor?: string; limit?: number }) {
      const matched = objects.filter((o) => o.key.startsWith(opts.prefix ?? ''));
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const limit = opts.limit ?? pageSize;
      const slice = matched.slice(start, start + limit);
      const next = start + limit;
      const truncated = next < matched.length;
      return {
        objects: slice,
        truncated,
        ...(truncated ? { cursor: String(next) } : {}),
      };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) deleted.push(k);
    },
  };
}

describe('runRetentionSweep — R2 artifact GC', () => {
  const NOW = 1_000_000_000_000;

  it('deletes artifact objects older than the window, retaining recent ones', async () => {
    const oldTs = new Date(NOW - 60 * DAY_MS); // older than default 30d
    const recentTs = new Date(NOW - 5 * DAY_MS); // within window
    const objects: FakeR2Object[] = [
      { key: 'artifacts/t1/th1/a.txt', uploaded: oldTs },
      { key: 'artifacts/t1/th1/b.txt', uploaded: oldTs },
      { key: 'artifacts/t2/th2/c.txt', uploaded: recentTs },
    ];
    const deleted: string[] = [];
    const sink: AuditEvent[] = [];
    const env = {
      BUNDLES: fakeBundles(objects, 1000, deleted),
      AUDIT_QUEUE: {
        send: (e: AuditEvent) => {
          sink.push(e);
          return Promise.resolve();
        },
      },
    } as unknown as Env;

    const result = await runRetentionSweep(env, NOW);

    expect(result.artifacts_deleted).toBe(2);
    expect(result.artifacts_capped).toBe(false);
    expect(deleted.sort()).toEqual(['artifacts/t1/th1/a.txt', 'artifacts/t1/th1/b.txt']);

    const summary = sink.find((e) => e.event_type === 'retention_sweep');
    expect(summary?.payload.artifacts_deleted).toBe(2);
    expect(summary?.payload.artifact_retention_days).toBe(DEFAULT_ARTIFACT_RETENTION_DAYS);
  });

  it('caps deletes at 5000 per tick and flags capped', async () => {
    const oldTs = new Date(NOW - 90 * DAY_MS);
    // 5001 deletable objects, small page size so the sweep paginates.
    const objects: FakeR2Object[] = Array.from({ length: 5001 }, (_, i) => ({
      key: `artifacts/t/th/${i}.txt`,
      uploaded: oldTs,
    }));
    const deleted: string[] = [];
    const env = {
      BUNDLES: fakeBundles(objects, 1000, deleted),
    } as unknown as Env;

    const result = await runRetentionSweep(env, NOW);

    expect(result.artifacts_deleted).toBe(5000);
    expect(result.artifacts_capped).toBe(true);
    expect(deleted).toHaveLength(5000);
  });
});

describe('memory_vectors retention (opt-in)', () => {
  const NOW = 1_000_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  it('parseMemoryRetentionDays — disabled by default, clamped when set', async () => {
    const { parseMemoryRetentionDays } = await import('../../src/jobs/retention');
    const env = (v?: string) => ({ MEMORY_RETENTION_DAYS: v }) as unknown as Env;
    expect(parseMemoryRetentionDays(env())).toBeNull();
    expect(parseMemoryRetentionDays(env(''))).toBeNull();
    expect(parseMemoryRetentionDays(env('nope'))).toBeNull();
    expect(parseMemoryRetentionDays(env('30'))).toBe(30);
    expect(parseMemoryRetentionDays(env('0'))).toBe(1);
    expect(parseMemoryRetentionDays(env('999999'))).toBe(3650);
  });

  it('sweeps memory_vectors only when MEMORY_RETENTION_DAYS is set', async () => {
    const deletes: string[] = [];
    const { sql } = makeFakeSql((q) => {
      deletes.push(q.text);
      return 0;
    });
    const base = {
      HYPERDRIVE: { connectionString: 'postgresql://fake' },
      AUDIT_QUEUE: { send: () => Promise.resolve() },
    };

    // Unset → the sweep never touches memory_vectors.
    const off = { ...base } as unknown as Env;
    const offResult = await withFakeDb(off, sql, () => runRetentionSweep(off, NOW));
    expect(offResult.memory_deleted).toBe(0);
    expect(deletes.some((t) => t.includes('memory_vectors'))).toBe(false);

    // Set → a bounded delete with the day-window cutoff runs.
    deletes.length = 0;
    const on = { ...base, MEMORY_RETENTION_DAYS: '30' } as unknown as Env;
    await withFakeDb(on, sql, () => runRetentionSweep(on, NOW));
    const memDelete = deletes.find((t) => t.includes('memory_vectors'));
    expect(memDelete).toBeDefined();
    expect(memDelete).toContain('created_at <');
  });
});
