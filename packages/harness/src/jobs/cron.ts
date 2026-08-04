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
 *
 * A job that is `enabled` and carries a `manifest_id` plus a `payload.input`
 * actually invokes its agent; anything else is swept and recorded without
 * executing. Execution runs under an UNATTENDED context scoped to the job's
 * own tenant — nobody is watching a cron tick, so human-gated tools fail
 * closed (`approvals/wrap.ts`), and the tenant has to be set explicitly or the
 * run would read and write the anonymous `default` tenant's data.
 */

import { recordEvent } from '../audit/store';
import {
  buildBackgroundContext,
  disposeContextDb,
  disposeLimitState,
  runWithContext,
} from '../context';
import type { Env } from '../env';
import { recordCounter } from '../observability/metrics';
import type { ToolProvider } from '../tools/provider';
import { jobExecutes, runJobAndAudit } from './execute';
import type { JobRecord } from './models';
import { claimJobSlot, listDueJobs, recordRun } from './store';

const MAX_DUE_PER_SWEEP = 500;
/**
 * How far ahead `nextRunAfter` will look. A year covers every schedule the
 * 5-field syntax can express except ones that genuinely never recur (e.g. a
 * Feb-30 date), which correctly resolve to null.
 */
const MAX_LOOKAHEAD_DAYS = 366;

/**
 * How many jobs may actually invoke an agent in one tick.
 *
 * Sweeping 500 due rows is cheap; running 500 agents is not, and exhausting
 * the cron invocation's budget would kill the tick mid-way and strand the
 * jobs after it. Work past this cap is deliberately left UNCLAIMED so its
 * `next_run_at` stays in the past and the next tick picks it up.
 */
const MAX_EXECUTIONS_PER_SWEEP = 5;

/**
 * Hard ceiling on one unattended job run, independent of whatever the manifest
 * declares. `limits.max_wall_clock_seconds` defaults to null (no timer), which
 * is a reasonable default for a request someone is watching and a poor one for
 * an automatic run nobody is.
 */
const JOB_WALL_CLOCK_CEILING_MS = 120_000;

export async function runScheduledJobs(
  env: Env,
  tools?: ToolProvider,
  at: Date = new Date(),
  execCtx?: ExecutionContext,
): Promise<void> {
  const jobs = await listDueJobs(env, at.getTime(), MAX_DUE_PER_SWEEP);
  let executions = 0;

  for (const job of jobs) {
    if (!job.schedule) continue;
    if (!cronMatches(job.schedule, at)) {
      // The index can over-select: a job whose `next_run_at` landed inside this
      // tick may not match the expression at this exact minute. Recompute and
      // move on without recording a run.
      await guard(job, 'reschedule', () =>
        recordRun(env, job.tenant_id, job.name, {
          last_run_at: job.last_run_at ?? 0,
          last_status: job.last_status,
          last_error: job.last_error,
          next_run_at: nextRunAfter(job.schedule, at),
        }),
      );
      continue;
    }

    // `listDueJobs` filters on a non-null `next_run_at`, but narrow rather than
    // assert — it is the compare-and-swap token below.
    if (job.next_run_at == null) continue;

    const willExecute = tools !== undefined && jobExecutes(job);
    if (willExecute && executions >= MAX_EXECUTIONS_PER_SWEEP) {
      recordCounter('orchestrator_job_deferred', { manifest_id: job.manifest_id || 'none' });
      continue;
    }

    const nextRun = nextRunAfter(job.schedule, new Date(at.getTime() + 60_000));
    // A transient database error while claiming must cost this job's turn, not
    // the rest of the sweep — jobs later in the list are unrelated to it.
    const claimed = await guard(job, 'claim', () =>
      claimJobSlot(env, job.tenant_id, job.name, job.next_run_at as number, nextRun),
    );
    if (!claimed) continue;

    if (!willExecute) {
      recordEvent({
        tenantId: job.tenant_id,
        eventType: 'job_run',
        manifestId: job.manifest_id,
        status: 'scheduled',
        payload: { job: job.name, schedule: job.schedule, trigger: 'scheduled' },
      });
      await finishRun(env, job, at, { status: 'scheduled', error: '', nextRun });
      continue;
    }

    executions += 1;
    const outcome = await runInJobContext(env, job, execCtx, () =>
      runJobAndAudit(env, tools, job, at.getTime(), 'scheduled'),
    );
    await finishRun(env, job, at, {
      status: outcome ? outcome.status : 'error',
      error: outcome ? outcome.error.slice(0, 1000) : 'job run did not complete',
      nextRun,
    });
  }
}

/**
 * Run `fn` under a context scoped to the job's tenant and flagged unattended.
 * Disposal mirrors every other background entrypoint so a long sweep doesn't
 * leak a Postgres client or an abort timer per job.
 */
async function runInJobContext<T>(
  env: Env,
  job: JobRecord,
  execCtx: ExecutionContext | undefined,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const ctx = buildBackgroundContext(env, {
    tenantId: job.tenant_id,
    subject: `job:${job.name}`,
    execCtx,
  });
  // A manifest that declares no `limits.max_wall_clock_seconds` gets no timer
  // at all, and the sweep runs jobs sequentially — so one hung invoke would
  // stall every job behind it until the platform kills the whole tick, leaving
  // their bookkeeping unwritten. Nobody is watching to notice. Abort the
  // request scope (which propagates to tools and model calls through
  // `ctx.signal`) and stop waiting.
  const timer = setTimeout(() => {
    ctx.limitState.abortController.abort(
      new Error('scheduled job exceeded its wall-clock ceiling'),
    );
  }, JOB_WALL_CLOCK_CEILING_MS);
  try {
    return await runWithContext(ctx, fn);
  } finally {
    clearTimeout(timer);
    disposeLimitState(ctx.limitState);
    disposeContextDb(ctx);
  }
}

/**
 * Run one per-job database step, swallowing failures so a single bad row can't
 * abort the sweep. Returns undefined when the step threw.
 */
async function guard<T>(
  job: JobRecord,
  step: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    console.error(`job ${job.tenant_id}/${job.name}: ${step} failed`, err);
    recordCounter('orchestrator_job_sweep_failures', { step });
    return undefined;
  }
}

/**
 * Persist the run outcome. The slot was already claimed and the run already
 * audited, so a bookkeeping failure here must not abort the rest of the sweep.
 */
async function finishRun(
  env: Env,
  job: JobRecord,
  at: Date,
  update: { status: string; error: string; nextRun: number | null },
): Promise<void> {
  try {
    await recordRun(env, job.tenant_id, job.name, {
      last_run_at: at.getTime(),
      last_status: update.status,
      last_error: update.error,
      next_run_at: update.nextRun,
    });
  } catch (err) {
    console.error(`job ${job.tenant_id}/${job.name}: failed to record run`, err);
    recordCounter('orchestrator_job_record_failures', { manifest_id: job.manifest_id || 'none' });
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
 * Next timestamp at or after `start` that matches `expression`, or null when
 * there is no match within `MAX_LOOKAHEAD_DAYS`.
 *
 * Used to backfill `next_run_at` on insert and after each run. Getting this
 * wrong is not a cosmetic problem: `listDueJobs` only selects rows with a
 * non-null `next_run_at`, so a job that returns null here is never swept
 * again — it stops firing permanently and silently.
 *
 * That is exactly what a naive minute-by-minute walk bounded at 24h did to
 * every schedule with a period longer than a day. `0 9 * * 1-5` firing on a
 * Friday has its next occurrence on Monday, 72 hours out, so the walk gave up
 * and killed the job. Weekly and monthly schedules never survived their first
 * run at all.
 *
 * The fix is to skip by day when the date fields can't match, rather than
 * grinding through 1440 minutes per day: at most ~366 day checks plus a bounded
 * hour/minute scan within a matching day. Field semantics stay identical to
 * `cronMatches` (day-of-month AND day-of-week, not the POSIX OR), so the value
 * this returns always satisfies the matcher the sweep re-checks it against.
 */
export function nextRunAfter(expression: string, start: Date): number | null {
  if (!expression) return null;
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minField, hourField, domField, monField, dowField] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  const cursor = new Date(start.getTime());
  // Round up to the next whole minute — `next_run_at` is a future firing.
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  for (let day = 0; day <= MAX_LOOKAHEAD_DAYS; day += 1) {
    const dateMatches =
      fieldMatches(domField, cursor.getUTCDate(), 1, 31) &&
      fieldMatches(monField, cursor.getUTCMonth() + 1, 1, 12) &&
      fieldMatches(dowField, cursor.getUTCDay(), 0, 6);

    if (dateMatches) {
      const fromHour = cursor.getUTCHours();
      for (let hh = fromHour; hh < 24; hh += 1) {
        if (!fieldMatches(hourField, hh, 0, 23)) continue;
        const fromMinute = hh === fromHour ? cursor.getUTCMinutes() : 0;
        for (let mm = fromMinute; mm < 60; mm += 1) {
          if (!fieldMatches(minField, mm, 0, 59)) continue;
          const found = new Date(cursor.getTime());
          found.setUTCHours(hh, mm, 0, 0);
          return found.getTime();
        }
      }
    }

    // Nothing left today — jump to the start of tomorrow.
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
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
