/**
 * Running a scheduled job's agent.
 *
 * Shared by the cron sweep and `POST /jobs/run/:name`, because the two differ
 * in exactly one thing that matters: whether a human is present. The cron path
 * wraps this in an unattended background context; the manual path calls it
 * inside the requesting operator's own context, so approval-gated tools behave
 * normally for a person who is standing there watching.
 *
 * Both paths assume a `RequestContext` is already installed — this function
 * never creates one, so the caller stays in control of the identity the run
 * executes under.
 */

import { recordEvent } from '../audit/store';
import { getContext } from '../context';
import type { Env } from '../env';
import { buildAgent } from '../manifests/builder';
import { resolveManifest } from '../manifests/resolver';
import { recordCounter } from '../observability/metrics';
import type { ToolProvider } from '../tools/provider';
import type { JobRecord } from './models';

/** How a single job run ended. */
export type JobRunStatus =
  /** The agent ran to completion. */
  | 'ok'
  /** The agent (or manifest resolution) failed. */
  | 'error'
  /** Nothing was run — the job isn't configured to execute. */
  | 'skipped';

export interface JobRunOutcome {
  status: JobRunStatus;
  /** Empty on success. */
  error: string;
  durationMs: number;
  /** First slice of the agent's answer, for the audit trail. */
  preview: string;
}

/** Longest answer excerpt written to audit — enough to tell what happened. */
const PREVIEW_CHARS = 500;

/**
 * The prompt a job run sends.
 *
 * Read from `payload.input`. A job with no input has nothing to ask the agent,
 * which is a configuration mistake rather than a runtime failure — the sweep
 * reports it as `skipped` so it doesn't look like the agent errored.
 */
export function jobInput(job: JobRecord): string | null {
  const raw = (job.payload as { input?: unknown }).input;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/** True when this job is configured to actually invoke a manifest. */
export function jobExecutes(job: JobRecord): boolean {
  return job.enabled && job.manifest_id !== '' && jobInput(job) !== null;
}

/**
 * Thread id for one firing.
 *
 * Every fire gets its OWN thread rather than appending to a long-lived one.
 * A job that ran hourly for a year would otherwise accumulate a session no
 * context strategy can render, and each fire is conceptually a fresh task, not
 * a continuation of the last one. Durable state a job needs across fires
 * belongs in memory or a store the agent writes to explicitly.
 */
export function jobThreadId(job: JobRecord, at: number): string {
  return `${job.tenant_id}:job-${job.name}-${at}`;
}

/**
 * Invoke the job's manifest once. Never throws — every failure is reported as
 * an `error` outcome so the sweep can record it and move to the next job.
 */
export async function runJobAgent(
  env: Env,
  tools: ToolProvider,
  job: JobRecord,
  at: number,
): Promise<JobRunOutcome> {
  const startedAt = Date.now();
  const finish = (status: JobRunStatus, error: string, preview = ''): JobRunOutcome => ({
    status,
    error,
    preview,
    durationMs: Date.now() - startedAt,
  });

  const input = jobInput(job);
  if (!job.enabled) return finish('skipped', 'job is not enabled for execution');
  if (!job.manifest_id) return finish('skipped', 'job has no manifest_id');
  if (!input) return finish('skipped', 'job payload has no `input` string');

  try {
    const resolved = await resolveManifest(env, job.tenant_id, job.manifest_id);
    if (!resolved) {
      return finish('error', `manifest '${job.manifest_id}' not found for this tenant`);
    }
    const agent = await buildAgent(resolved.manifest, { env, tools });
    const result = await agent.invoke({
      messages: [{ role: 'user', content: input }],
      threadId: jobThreadId(job, at),
    });
    return finish('ok', '', (result.final.content ?? '').slice(0, PREVIEW_CHARS));
  } catch (err) {
    return finish('error', String((err as Error).message ?? err));
  }
}

/**
 * Run the job and write its `job_run` audit row + counter. Returns the outcome
 * so the caller can persist it onto the job record.
 */
export async function runJobAndAudit(
  env: Env,
  tools: ToolProvider,
  job: JobRecord,
  at: number,
  trigger: 'scheduled' | 'manual',
): Promise<JobRunOutcome> {
  const outcome = await runJobAgent(env, tools, job, at);
  recordEvent({
    tenantId: job.tenant_id,
    eventType: 'job_run',
    principalSubject: getContext()?.auth.principal.subject ?? '',
    manifestId: job.manifest_id,
    status: outcome.status,
    payload: {
      job: job.name,
      trigger,
      schedule: job.schedule,
      duration_ms: outcome.durationMs,
      thread_id: jobThreadId(job, at),
      unattended: getContext()?.unattended === true,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.preview ? { output_preview: outcome.preview } : {}),
    },
  });
  recordCounter('orchestrator_job_runs', {
    status: outcome.status,
    trigger,
    manifest_id: job.manifest_id || 'none',
  });
  return outcome;
}
