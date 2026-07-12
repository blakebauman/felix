/**
 * Retention / garbage-collection sweep.
 *
 * Day-2 cost control: several D1 tables grow without bound. This cron task
 * prunes the clearly-safe, highest-value deletions each tick:
 *
 *   1. `audit_events` older than a configurable retention window
 *      (`AUDIT_RETENTION_DAYS`, default 90) — a global, time-window delete.
 *   2. expired `plans` rows (`expires_at IS NOT NULL AND expires_at < now`).
 *   3. R2 artifact spills (`artifacts/<tenant>/<thread>/<tool_call>.txt`)
 *      whose `uploaded` timestamp is older than `ARTIFACT_RETENTION_DAYS`
 *      (default 30) — an R2 `list` + bounded `delete`.
 *
 * Every delete is BOUNDED per tick (`MAX_DELETES_PER_TABLE`) so one sweep
 * can't exceed D1/R2 subrequest/time limits — if more qualifies it rolls off
 * on the next tick. SQLite/D1 doesn't support `DELETE ... LIMIT`, so the D1
 * deletes bound via a `rowid IN (SELECT ... LIMIT ?)` subquery, which stays
 * indexed on the scanned column (`ts` for audit, `expires_at` for plans — see
 * the `0021_retention_index.sql` migration). The R2 sweep bounds itself by
 * capping both the number of objects deleted and the number of `list` pages
 * scanned per tick (artifact keys carry no time ordering, so old objects can
 * only be found by scanning).
 *
 * Out of scope (deliberately): Vectorize GC — tracked as a follow-up.
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

/** Retention window default + clamp bounds for `ARTIFACT_RETENTION_DAYS`. */
export const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;
const MIN_ARTIFACT_RETENTION_DAYS = 1;
const MAX_ARTIFACT_RETENTION_DAYS = 3650;

/** R2 keyspace prefix for artifact spills (see `tools/artifacts.ts`). */
const ARTIFACT_PREFIX = 'artifacts/';
/** R2 `list`/`delete` page size (platform max is 1000). */
const R2_PAGE_SIZE = 1000;
/**
 * Cap on `list` pages scanned per tick. Artifact keys carry no time ordering,
 * so a bucket dominated by recent objects could otherwise page unbounded
 * looking for old ones — this bounds the scan work regardless of hit rate.
 */
const MAX_ARTIFACT_LIST_PAGES = 20;

/**
 * Hard cap on rows/objects deleted per table per tick. Bounds each `DELETE` to
 * a single D1 statement (or a handful of R2 delete calls) well within
 * subrequest/time limits; a large backlog drains over successive ticks rather
 * than in one oversized delete.
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

/**
 * Resolve the artifact retention window (days) from the optional
 * `ARTIFACT_RETENTION_DAYS` env var. Parsed defensively (mirrors
 * `parseAuditRetentionDays`): unset / non-numeric falls back to the default,
 * valid values are floored and clamped to `[MIN_ARTIFACT_RETENTION_DAYS,
 * MAX_ARTIFACT_RETENTION_DAYS]`.
 */
export function parseArtifactRetentionDays(env: Env): number {
  const raw = env.ARTIFACT_RETENTION_DAYS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_ARTIFACT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_ARTIFACT_RETENTION_DAYS;
  return Math.max(
    MIN_ARTIFACT_RETENTION_DAYS,
    Math.min(MAX_ARTIFACT_RETENTION_DAYS, Math.floor(n)),
  );
}

export interface RetentionSweepResult {
  audit_deleted: number;
  plans_deleted: number;
  artifacts_deleted: number;
  /** True when a table/bucket hit the per-tick cap — more remains for next tick. */
  audit_capped: boolean;
  plans_capped: boolean;
  artifacts_capped: boolean;
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
 * Sweep R2 artifact spills older than `cutoff`. Bounded per tick by both the
 * delete cap (`MAX_DELETES_PER_TABLE`) and the scanned-page cap
 * (`MAX_ARTIFACT_LIST_PAGES`). No-op when the `BUNDLES` bucket is unbound.
 */
async function sweepArtifacts(
  env: Env,
  cutoff: number,
): Promise<{ deleted: number; capped: boolean }> {
  if (!env.BUNDLES) return { deleted: 0, capped: false };
  const toDelete: string[] = [];
  let cursor: string | undefined;
  let capped = false;
  for (let page = 0; page < MAX_ARTIFACT_LIST_PAGES; page += 1) {
    const listing = await env.BUNDLES.list({
      prefix: ARTIFACT_PREFIX,
      limit: R2_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const obj of listing.objects) {
      if (obj.uploaded.getTime() < cutoff) toDelete.push(obj.key);
    }
    if (toDelete.length >= MAX_DELETES_PER_TABLE) {
      // More may qualify but we've hit the per-tick delete cap.
      capped = true;
      break;
    }
    if (listing.truncated) {
      cursor = listing.cursor;
      // Ran out of scan budget with pages still unread — more may qualify.
      if (page === MAX_ARTIFACT_LIST_PAGES - 1) capped = true;
    } else {
      break; // scanned the whole keyspace.
    }
  }
  const batch = toDelete.slice(0, MAX_DELETES_PER_TABLE);
  let deleted = 0;
  for (let i = 0; i < batch.length; i += R2_PAGE_SIZE) {
    const chunk = batch.slice(i, i + R2_PAGE_SIZE);
    await env.BUNDLES.delete(chunk);
    deleted += chunk.length;
  }
  return { deleted, capped };
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
    artifacts_deleted: 0,
    audit_capped: false,
    plans_capped: false,
    artifacts_capped: false,
    errors: [],
  };

  const retentionDays = parseAuditRetentionDays(env);
  const auditCutoff = now - retentionDays * DAY_MS;

  // D1 deletes only run when the database is bound; the R2 artifact sweep below
  // is independent so it still runs when only the bucket is wired.
  if (env.DB) {
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
  }

  const artifactDays = parseArtifactRetentionDays(env);
  const artifactCutoff = now - artifactDays * DAY_MS;
  try {
    const swept = await sweepArtifacts(env, artifactCutoff);
    result.artifacts_deleted = swept.deleted;
    result.artifacts_capped = swept.capped;
  } catch (err) {
    result.errors.push(`artifacts: ${(err as Error).message ?? String(err)}`);
    console.error('retention sweep — artifact delete failed', err);
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
        artifact_retention_days: artifactDays,
        audit_deleted: result.audit_deleted,
        plans_deleted: result.plans_deleted,
        artifacts_deleted: result.artifacts_deleted,
        audit_capped: result.audit_capped,
        plans_capped: result.plans_capped,
        artifacts_capped: result.artifacts_capped,
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
  recordCounterDetached(
    env,
    'orchestrator_retention_deleted',
    { table: 'artifacts' },
    result.artifacts_deleted,
  );

  console.log(
    `[retention] sweep — audit_deleted=${result.audit_deleted} plans_deleted=${result.plans_deleted} ` +
      `artifacts_deleted=${result.artifacts_deleted} retention_days=${retentionDays} ` +
      `artifact_retention_days=${artifactDays} ` +
      `capped=${result.audit_capped || result.plans_capped || result.artifacts_capped}`,
  );
  return result;
}
