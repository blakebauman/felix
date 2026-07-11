/**
 * Cron entrypoint.
 *
 * The worker-level cron in wrangler.jsonc fires every 10 minutes. We pull
 * the jobs that are due (`next_run_at <= now`) via the indexed scan in
 * `listDueJobs`, run each under its owning tenant's identity, and update
 * `next_run_at` for the next firing.
 *
 * Per-job schedules use the standard 5-field cron syntax:
 * `minute hour day-of-month month day-of-week`. Jobs with an empty
 * schedule are on-demand only — they're never returned by `listDueJobs`.
 */

import { recordEvent } from '../audit/store';
import type { Env } from '../env';
import { listDueJobs, recordRun } from './store';

const MAX_DUE_PER_SWEEP = 500;
const NEXT_RUN_LOOKAHEAD_MINUTES = 24 * 60; // walk forward up to a day

export async function runScheduledJobs(env: Env, at: Date = new Date()): Promise<void> {
  const jobs = await listDueJobs(env, at.getTime(), MAX_DUE_PER_SWEEP);
  for (const job of jobs) {
    if (!job.schedule) continue;
    if (!cronMatches(job.schedule, at)) {
      // index can over-select if a job's next_run_at was scheduled for the
      // current tick but the minute granularity differs — recompute and skip.
      await recordRun(env, job.tenant_id, job.name, {
        last_run_at: job.last_run_at ?? 0,
        last_status: job.last_status,
        last_error: job.last_error,
        next_run_at: nextRunAfter(job.schedule, at),
      });
      continue;
    }
    try {
      await recordRun(env, job.tenant_id, job.name, {
        last_run_at: at.getTime(),
        last_status: 'scheduled',
        last_error: '',
        next_run_at: nextRunAfter(job.schedule, new Date(at.getTime() + 60_000)),
      });
      recordEvent({
        tenantId: job.tenant_id,
        eventType: 'job_run',
        manifestId: job.manifest_id,
        status: 'scheduled',
        payload: { job: job.name, schedule: job.schedule },
      });
    } catch (err) {
      await recordRun(env, job.tenant_id, job.name, {
        last_run_at: at.getTime(),
        last_status: 'error',
        last_error: String((err as Error).message ?? err),
        next_run_at: nextRunAfter(job.schedule, new Date(at.getTime() + 60_000)),
      });
    }
  }
}

/**
 * Minimal 5-field cron matcher. Supports:
 *   - `*`           — any
 *   - `5`           — literal
 *   - `1,3,5`       — list
 *   - `1-5`         — range
 *   - `*\/N` / `0-30/5` — step (over `*` or range)
 *
 * Not supported: named day/month aliases, `L`, `W`, `#`. Returns true iff
 * every field matches the corresponding component of `at` (UTC).
 */
export function cronMatches(expression: string, at: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;
  return (
    fieldMatches(m!, at.getUTCMinutes(), 0, 59) &&
    fieldMatches(h!, at.getUTCHours(), 0, 23) &&
    fieldMatches(dom!, at.getUTCDate(), 1, 31) &&
    fieldMatches(mon!, at.getUTCMonth() + 1, 1, 12) &&
    fieldMatches(dow!, at.getUTCDay(), 0, 6)
  );
}

/**
 * Walk forward from `start` minute-by-minute until the expression matches,
 * or give up after a day. Used to backfill `next_run_at` on insert and
 * post-run. The half-precision (minute-granular) sweep tick is fine since
 * the cron trigger runs every 10 minutes anyway.
 */
export function nextRunAfter(expression: string, start: Date): number | null {
  if (!expression) return null;
  const cursor = new Date(start.getTime());
  // Round up to the next whole minute.
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let i = 0; i < NEXT_RUN_LOOKAHEAD_MINUTES; i += 1) {
    if (cronMatches(expression, cursor)) return cursor.getTime();
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(',')) {
    if (subFieldMatches(part, value, min, max)) return true;
  }
  return false;
}

function subFieldMatches(part: string, value: number, min: number, max: number): boolean {
  const [base, stepStr] = part.split('/');
  const step = stepStr ? Number(stepStr) : 1;
  if (Number.isNaN(step) || step <= 0) return false;

  let lo = min;
  let hi = max;
  if (base && base !== '*') {
    const range = base.split('-');
    if (range.length === 1) {
      const n = Number(range[0]);
      if (Number.isNaN(n)) return false;
      if (step === 1) return n === value;
      lo = n;
      hi = max;
    } else if (range.length === 2) {
      const a = Number(range[0]);
      const b = Number(range[1]);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      lo = a;
      hi = b;
    } else {
      return false;
    }
  }
  if (value < lo || value > hi) return false;
  return (value - lo) % step === 0;
}
