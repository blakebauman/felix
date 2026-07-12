/**
 * Retention / garbage-collection sweep.
 *
 * Day-2 cost control: several D1 tables grow without bound. This cron task
 * prunes the clearly-safe, highest-value deletions each tick:
 *
 *   1. `audit_events` older than a configurable retention window
 *      (`AUDIT_RETENTION_DAYS`, default 90) — a global, time-window delete.
 *   2. expired `plans` rows (`expires_at IS NOT NULL AND expires_at < now`).
 *
 * Both deletes are BOUNDED per tick (`MAX_DELETES_PER_TABLE`) so one sweep
 * can't exceed D1 subrequest/time limits — if more rows qualify they roll
 * off on the next tick. SQLite/D1 doesn't support `DELETE ... LIMIT`, so we
 * bound via a `rowid IN (SELECT ... LIMIT ?)` subquery, which stays indexed
 * on the scanned column (`ts` for audit, `expires_at` for plans — see the
 * `0021_retention_index.sql` migration).
 *
 * Out of scope (deliberately): Vectorize GC, ConversationDO idle TTL, and
 * R2 artifact lifecycle — those need DO alarms / bucket lifecycle rules and
 * are tracked as follow-ups.
 *
 * The sweep runs under the cron's anonymous `RequestContext`, but it uses
 * the `*Detached` audit/metric helpers (env passed explicitly) so it's
 * observable without depending on AsyncLocalStorage and testable with a
 * plain stub Env.
 */

import { recordEventDetached } from '../audit/store';
import type { Env } from '../env';
import { recordCounterDetached } from '../observability/metrics';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention window default + clamp bounds for `AUDIT_RETENTION_DAYS`. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 3650; // ~10 years — an effective "keep forever" ceiling.

/**
 * Hard cap on rows deleted per table per tick. Bounds each `DELETE` to a
 * single D1 statement well within subrequest/time limits; a large backlog
 * drains over successive ticks rather than in one oversized delete.
 */
const MAX_DELETES_PER_TABLE = 5000;

/**
 * Resolve the audit retention window (days) from the optional
 * `AUDIT_RETENTION_DAYS` env var. Parsed defensively: unset / non-numeric
 * falls back to the default, and valid values are floored and clamped to
 * `[MIN_RETENTION_DAYS, MAX_RETENTION_DAYS]` so a fat-fingered override
 * can never delete the entire log (0 days) or overflow.
 */
export function parseAuditRetentionDays(env: Env): number {
  const raw = env.AUDIT_RETENTION_DAYS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_AUDIT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_AUDIT_RETENTION_DAYS;
  return Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, Math.floor(n)));
}

export interface RetentionSweepResult {
  audit_deleted: number;
  plans_deleted: number;
  /** True when a table hit the per-tick cap — more remains for next tick. */
  audit_capped: boolean;
  plans_capped: boolean;
  errors: string[];
}

/** Bounded delete via `rowid IN (SELECT ... LIMIT ?)`; returns rows deleted. */
async function boundedDelete(
  env: Env,
  table: 'audit_events' | 'plans',
  where: string,
  cutoff: number,
): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM ${table}
       WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`,
  )
    .bind(cutoff, MAX_DELETES_PER_TABLE)
    .run();
  return res.meta?.changes ?? 0;
}

/**
 * Run one retention/GC tick. Called from `scheduled()` once per cron
 * interval, isolated in its own try/catch. Each table's delete is
 * independently guarded so a failure on one still lets the other proceed
 * and still emits an observable summary.
 */
export async function runRetentionSweep(
  env: Env,
  now: number = Date.now(),
  execCtx?: ExecutionContext,
): Promise<RetentionSweepResult> {
  const result: RetentionSweepResult = {
    audit_deleted: 0,
    plans_deleted: 0,
    audit_capped: false,
    plans_capped: false,
    errors: [],
  };
  if (!env.DB) return result;

  const retentionDays = parseAuditRetentionDays(env);
  const auditCutoff = now - retentionDays * DAY_MS;

  try {
    result.audit_deleted = await boundedDelete(env, 'audit_events', 'ts < ?', auditCutoff);
    result.audit_capped = result.audit_deleted >= MAX_DELETES_PER_TABLE;
  } catch (err) {
    result.errors.push(`audit_events: ${(err as Error).message ?? String(err)}`);
    console.error('retention sweep — audit_events delete failed', err);
  }

  try {
    result.plans_deleted = await boundedDelete(
      env,
      'plans',
      'expires_at IS NOT NULL AND expires_at < ?',
      now,
    );
    result.plans_capped = result.plans_deleted >= MAX_DELETES_PER_TABLE;
  } catch (err) {
    result.errors.push(`plans: ${(err as Error).message ?? String(err)}`);
    console.error('retention sweep — plans delete failed', err);
  }

  // Observability: a global sweep has no owning tenant, so the summary lands
  // under `default` (the cron's anonymous identity), like the other crons.
  recordEventDetached(
    env,
    {
      tenantId: 'default',
      eventType: 'retention_sweep',
      status: result.errors.length > 0 ? 'error' : 'ok',
      payload: {
        audit_retention_days: retentionDays,
        audit_deleted: result.audit_deleted,
        plans_deleted: result.plans_deleted,
        audit_capped: result.audit_capped,
        plans_capped: result.plans_capped,
        max_deletes_per_table: MAX_DELETES_PER_TABLE,
        ...(result.errors.length > 0 ? { errors: result.errors } : {}),
      },
    },
    execCtx,
  );
  recordCounterDetached(
    env,
    'orchestrator_retention_deleted',
    { table: 'audit_events' },
    result.audit_deleted,
  );
  recordCounterDetached(
    env,
    'orchestrator_retention_deleted',
    { table: 'plans' },
    result.plans_deleted,
  );

  console.log(
    `[retention] sweep — audit_deleted=${result.audit_deleted} plans_deleted=${result.plans_deleted} ` +
      `retention_days=${retentionDays} capped=${result.audit_capped || result.plans_capped}`,
  );
  return result;
}
