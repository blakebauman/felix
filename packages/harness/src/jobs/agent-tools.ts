/**
 * Agent-facing scheduling: let an agent set up its own recurring work and read
 * back how prior runs went.
 *
 * The execution half already exists — the cron sweep resolves a job's manifest
 * and invokes it. What was missing is any way for the agent to create one, or
 * to learn what happened on a previous fire. That second half matters more than
 * it sounds: every firing runs in a FRESH thread with no memory of the last
 * one, so without a fire log an agent has no way to tell a job has been failing
 * for a week.
 *
 * Three guards, because scheduling is a privilege and not just a convenience:
 *
 * 1. **The manifest is pinned to the caller's own.** An agent can schedule
 *    ITSELF and nothing else. Letting it name a manifest would be a privilege
 *    escalation with extra steps — pick the one with the widest tool set and
 *    have the sweep run it unattended.
 * 2. **A frequency floor**, measured across the schedule's whole cadence
 *    rather than its next two firings — an uneven expression can show a wide
 *    first gap and a one-minute one right after. `* * * * *` would otherwise
 *    run a full agent every sweep, indefinitely, on one model decision.
 * 3. **A per-tenant cap**, so a loop that keeps calling this can't fill the
 *    table.
 * 4. **Per-manifest ownership.** Reads, cancels, and replacements are scoped to
 *    the caller's own manifest, so one agent cannot enumerate, cancel, or take
 *    over another's schedule by name collision within a shared tenant.
 *
 * Scheduled runs are unattended, so approval-gated tools fail closed inside
 * them regardless of what gets scheduled here (see `approvals/wrap.ts`).
 */

import { z } from 'zod';
import { recordEvent } from '../audit/store';
import { getContext } from '../context';
import type { Env } from '../env';
import { ToolError, toolErrorOutput } from '../tools/errors';
import { defineTool, type Tool } from '../tools/types';
import { nextRunAfter } from './cron';
import { JobRecordSchema } from './models';
import { countJobs, deleteJob, getJob, listJobRuns, listJobs, upsertJob } from './store';

/**
 * Closest two firings a schedule may have. The cron trigger itself runs every
 * 10 minutes, so anything under that can't be honoured anyway; 15 leaves room
 * without inviting a job that fires on every single sweep.
 */
const MIN_INTERVAL_MINUTES = 15;

/** Most jobs one tenant may hold. */
const MAX_JOBS_PER_TENANT = 25;

/** Job names an agent may create — same charset as the REST surface. */
const NAME_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

interface ToolEnv {
  env: Env;
  tenantId: string;
  manifestId: string;
}

/**
 * Resolve the caller's tenant and manifest, or refuse.
 *
 * The manifest is what the scheduled run will execute as, so being unable to
 * identify it is not something to paper over with a default — that would
 * schedule work as an arbitrary agent.
 */
function callerFor(ctxManifestId: string | undefined): ToolEnv {
  const ctx = getContext();
  if (!ctx) {
    throw new ToolError('internal', 'no request context — cannot determine the calling tenant');
  }
  const manifestId = ctxManifestId ?? ctx.manifestId;
  if (!manifestId) {
    throw new ToolError(
      'internal',
      'cannot determine the calling manifest, so the scheduled run has no identity to execute as',
    );
  }
  return { env: ctx.env, tenantId: ctx.auth.principal.tenantId, manifestId };
}

/**
 * How many consecutive firings to sample when measuring a schedule's cadence.
 * Enough to cover a full day of even a fairly dense expression, so an uneven
 * one can't hide its tight stretch beyond the window.
 */
const CADENCE_SAMPLES = 64;

/**
 * SMALLEST gap between consecutive firings of `schedule`, in minutes, or null
 * when it never fires twice.
 *
 * Measuring only the next two firings is not enough, and the failure is not
 * subtle: `0,58,59 * * * *` asked at 12:59 reports a 58-minute gap while
 * actually firing at :58, :59, and :00 — one minute apart, every hour. An
 * uneven schedule can present a wide first gap and a tight one immediately
 * after, so the floor has to look at the whole cadence rather than the next
 * pair the caller happens to land on.
 */
export function scheduleIntervalMinutes(schedule: string, from = new Date()): number | null {
  let cursor = from;
  let previous: number | null = null;
  let smallest = Number.POSITIVE_INFINITY;

  for (let i = 0; i < CADENCE_SAMPLES; i += 1) {
    const next = nextRunAfter(schedule, cursor);
    if (next === null) break;
    if (previous !== null) smallest = Math.min(smallest, (next - previous) / 60_000);
    previous = next;
    cursor = new Date(next);
  }
  return Number.isFinite(smallest) ? smallest : null;
}

export function buildSchedulingTools(): Tool[] {
  return [
    defineTool({
      name: 'schedule_task',
      description:
        'Schedule recurring work for yourself. The task runs on a cron schedule in a FRESH ' +
        'conversation with no memory of previous runs or of this one, so `input` must be ' +
        'self-contained. Creating a task with an existing name replaces it.',
      args: z
        .object({
          name: z
            .string()
            .describe('Stable identifier, 1-128 chars of letters, digits, dot, dash, underscore.'),
          schedule: z
            .string()
            .describe('5-field cron expression in UTC, e.g. "0 9 * * 1-5" for weekdays at 09:00.'),
          input: z
            .string()
            .describe('The self-contained instruction each run receives as its user message.'),
        })
        .strict(),
      async handler({ name, schedule, input }, ctx) {
        const { env, tenantId, manifestId } = callerFor(ctx?.manifestId);

        if (!NAME_PATTERN.test(name)) {
          return toolErrorOutput(
            'invalid_arguments',
            `[invalid name] '${name}' must be 1-128 characters of letters, digits, '.', '-', or '_'.`,
          );
        }
        if (!input.trim()) {
          return toolErrorOutput(
            'invalid_arguments',
            '[invalid input] a task needs a non-empty instruction; it runs with no other context.',
          );
        }

        const interval = scheduleIntervalMinutes(schedule);
        if (interval === null) {
          return toolErrorOutput(
            'invalid_arguments',
            `[invalid schedule] '${schedule}' is not a 5-field cron expression that fires at least twice in the next year.`,
          );
        }
        if (interval < MIN_INTERVAL_MINUTES) {
          return toolErrorOutput(
            'permission_denied',
            `[schedule too frequent] '${schedule}' fires every ${interval} minutes; the minimum is ` +
              `${MIN_INTERVAL_MINUTES}. Each run is a full agent invocation, so pick a wider interval.`,
          );
        }

        // Scoped to this manifest: a job owned by a DIFFERENT manifest of the
        // same tenant must not be silently taken over by a name collision,
        // which would redirect its unattended runs to another agent's tool set.
        const existing = await getJob(env, tenantId, name, manifestId);
        const collision = existing ? null : await getJob(env, tenantId, name);
        if (collision) {
          return toolErrorOutput(
            'permission_denied',
            `[name taken] '${name}' is already scheduled by another agent in this tenant; pick a different name.`,
          );
        }
        if (!existing && (await countJobs(env, tenantId)) >= MAX_JOBS_PER_TENANT) {
          return toolErrorOutput(
            'permission_denied',
            `[limit reached] this tenant already has ${MAX_JOBS_PER_TENANT} scheduled tasks; cancel one before adding another.`,
          );
        }

        const now = Date.now();
        const job = JobRecordSchema.parse({
          tenant_id: tenantId,
          name,
          schedule,
          // Pinned, never taken from arguments: a scheduled run executes as
          // this manifest, and letting the model choose would be a privilege
          // escalation.
          manifest_id: manifestId,
          payload: { input },
          enabled: true,
          created_at: existing?.created_at ?? now,
          next_run_at: nextRunAfter(schedule, new Date(now)),
        });
        await upsertJob(env, job);
        // Creating recurring unattended work is the privileged act here, and
        // until the job actually fires there is otherwise no trace of it —
        // only the eventual `job_run` rows.
        recordEvent({
          tenantId,
          eventType: 'job_scheduled',
          principalSubject: getContext()?.auth.principal.subject ?? '',
          manifestId,
          status: existing ? 'replaced' : 'created',
          payload: { job: name, schedule, interval_minutes: interval, by: 'agent' },
        });

        const nextRun = job.next_run_at ? new Date(job.next_run_at).toISOString() : 'unscheduled';
        return `${existing ? 'Replaced' : 'Scheduled'} '${name}' (${schedule}). Next run: ${nextRun}.`;
      },
    }),

    defineTool({
      name: 'list_scheduled_tasks',
      description:
        'List the recurring tasks scheduled for this tenant, with their schedule, next run, and ' +
        'the outcome of their most recent run.',
      args: z.object({}).strict(),
      async handler(_args, ctx) {
        const { env, tenantId, manifestId } = callerFor(ctx?.manifestId);
        const jobs = await listJobs(env, tenantId, manifestId);
        if (jobs.length === 0) return 'No scheduled tasks.';
        return jobs
          .map((job) => {
            const next = job.next_run_at ? new Date(job.next_run_at).toISOString() : 'none';
            const last = job.last_run_at
              ? `${job.last_status || 'unknown'} at ${new Date(job.last_run_at).toISOString()}`
              : 'never run';
            const state = job.enabled ? '' : ' [disabled]';
            return `- ${job.name}${state} (${job.schedule}) — next: ${next}; last: ${last}`;
          })
          .join('\n');
      },
    }),

    defineTool({
      name: 'scheduled_task_runs',
      description:
        'Read the recent run history of one scheduled task — when it fired, whether it succeeded, ' +
        'and what it produced. Each run happens in a fresh conversation, so this is the only way ' +
        'to see how previous runs went.',
      args: z
        .object({
          name: z.string(),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .strict(),
      async handler({ name, limit }, ctx) {
        const { env, tenantId, manifestId } = callerFor(ctx?.manifestId);
        const job = await getJob(env, tenantId, name, manifestId);
        if (!job) {
          return toolErrorOutput(
            'invalid_arguments',
            `[not found] no scheduled task named '${name}'.`,
          );
        }

        // Scoped by manifest as well as name, so a task cancelled and later
        // recreated under a different agent doesn't inherit its history.
        const runs = await listJobRuns(env, tenantId, name, limit ?? 20, manifestId);
        if (runs.length === 0) return `'${name}' has not run yet.`;
        return runs
          .map((run) => {
            const when = new Date(run.fired_at).toISOString();
            const detail = run.error
              ? ` error: ${run.error.slice(0, 200)}`
              : run.output_preview
                ? ` output: ${run.output_preview.slice(0, 200)}`
                : '';
            return `- ${when} ${run.status} (${run.duration_ms}ms, ${run.trigger || 'scheduled'})${detail}`;
          })
          .join('\n');
      },
    }),

    defineTool({
      name: 'cancel_scheduled_task',
      description: 'Cancel a recurring task so it stops running. Its run history is retained.',
      args: z.object({ name: z.string() }).strict(),
      async handler({ name }, ctx) {
        const { env, tenantId, manifestId } = callerFor(ctx?.manifestId);
        const removed = await deleteJob(env, tenantId, name, manifestId);
        if (removed) {
          recordEvent({
            tenantId,
            eventType: 'job_scheduled',
            principalSubject: getContext()?.auth.principal.subject ?? '',
            manifestId,
            status: 'cancelled',
            payload: { job: name, by: 'agent' },
          });
        }
        return removed
          ? `Cancelled '${name}'. It will not run again.`
          : toolErrorOutput('invalid_arguments', `[not found] no scheduled task named '${name}'.`);
      },
    }),
  ];
}

/** Names of the tools this module contributes, for registration + docs. */
export const SCHEDULING_TOOL_NAMES = [
  'schedule_task',
  'list_scheduled_tasks',
  'scheduled_task_runs',
  'cancel_scheduled_task',
] as const;
