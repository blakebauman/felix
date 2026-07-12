/**
 * Retention-sweep unit tests.
 *
 * Pins the GC contract: `runRetentionSweep` prunes audit_events older than
 * the retention window and expired plans, in BOUNDED batches, while
 * retaining recent rows — and emits an observable summary. The DB is stubbed
 * as an in-memory model so the test stays decoupled from D1.
 */

import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../src/audit/models';
import type { Env } from '../../src/env';
import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  parseAuditRetentionDays,
  runRetentionSweep,
} from '../../src/jobs/retention';

const DAY_MS = 24 * 60 * 60 * 1000;

interface AuditRow {
  ts: number;
}
interface PlanRow {
  expires_at: number | null;
}

/**
 * In-memory D1 stub that understands only the two bounded-delete queries the
 * sweep issues. It parses the LIMIT bind and the cutoff bind, applies the
 * predicate, deletes up to LIMIT matching rows, and reports `meta.changes`.
 */
function fakeEnv(audit: AuditRow[], plans: PlanRow[], sink: AuditEvent[]): Env {
  return {
    DB: {
      prepare(sql: string) {
        const isAudit = sql.includes('audit_events');
        return {
          bind(cutoff: number, limit: number) {
            return {
              async run() {
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
                    if (r.expires_at !== null && r.expires_at < cutoff && changes < limit)
                      changes += 1;
                    else survivors.push(r);
                  }
                  plans.length = 0;
                  plans.push(...survivors);
                }
                return { meta: { changes } };
              },
            };
          },
        };
      },
    },
    AUDIT_QUEUE: {
      send: (e: AuditEvent) => {
        sink.push(e);
        return Promise.resolve();
      },
    },
  } as unknown as Env;
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

    const result = await runRetentionSweep(fakeEnv(audit, plans, sink), NOW);

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

    const result = await runRetentionSweep(fakeEnv(audit, [], sink), NOW);

    expect(result.audit_deleted).toBe(5000);
    expect(result.audit_capped).toBe(true);
    // One row remains for the next tick.
    expect(audit).toHaveLength(1);
  });

  it('is a no-op with no DB binding', async () => {
    const result = await runRetentionSweep({} as unknown as Env, NOW);
    expect(result).toEqual({
      audit_deleted: 0,
      plans_deleted: 0,
      audit_capped: false,
      plans_capped: false,
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
});
