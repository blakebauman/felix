/**
 * Job registry (D1). Every query is scoped by tenant_id — the migration
 * 0002 rewrote the table with a composite (tenant_id, name) primary key,
 * matching the rest of the schema.
 */

import type { Env } from '../env';
import { type JobRecord, JobRecordSchema } from './models';

interface JobRow {
  tenant_id: string;
  name: string;
  schedule: string;
  manifest_id: string;
  last_run_at: number | null;
  next_run_at: number | null;
  last_status: string;
  last_error: string;
  created_at: number;
  payload_json: string;
}

function rowToJob(row: JobRow): JobRecord {
  return JobRecordSchema.parse({
    tenant_id: row.tenant_id,
    name: row.name,
    schedule: row.schedule,
    manifest_id: row.manifest_id,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    last_status: row.last_status,
    last_error: row.last_error,
    created_at: row.created_at,
    payload: safeJson(row.payload_json),
  });
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export async function listJobs(env: Env, tenantId: string): Promise<JobRecord[]> {
  const rows = await env.DB.prepare('SELECT * FROM jobs WHERE tenant_id = ? ORDER BY name')
    .bind(tenantId)
    .all<JobRow>();
  return (rows.results ?? []).map(rowToJob);
}

export async function getJob(env: Env, tenantId: string, name: string): Promise<JobRecord | null> {
  const row = await env.DB.prepare('SELECT * FROM jobs WHERE tenant_id = ? AND name = ? LIMIT 1')
    .bind(tenantId, name)
    .first<JobRow>();
  return row ? rowToJob(row) : null;
}

export async function upsertJob(env: Env, job: JobRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs (tenant_id, name, schedule, manifest_id, last_run_at, next_run_at,
                       last_status, last_error, created_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, name) DO UPDATE SET
       schedule = excluded.schedule,
       manifest_id = excluded.manifest_id,
       next_run_at = excluded.next_run_at,
       payload_json = excluded.payload_json`,
  )
    .bind(
      job.tenant_id,
      job.name,
      job.schedule,
      job.manifest_id,
      job.last_run_at ?? null,
      job.next_run_at ?? null,
      job.last_status,
      job.last_error,
      job.created_at,
      JSON.stringify(job.payload),
    )
    .run();
}

export async function recordRun(
  env: Env,
  tenantId: string,
  name: string,
  update: {
    last_run_at: number;
    last_status: string;
    last_error: string;
    next_run_at?: number | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs
       SET last_run_at = ?, last_status = ?, last_error = ?, next_run_at = ?
       WHERE tenant_id = ? AND name = ?`,
  )
    .bind(
      update.last_run_at,
      update.last_status,
      update.last_error,
      update.next_run_at ?? null,
      tenantId,
      name,
    )
    .run();
}

/**
 * Scheduled-sweep view. Returns jobs whose `next_run_at` is at or before
 * `asOfMs` (i.e. due to fire), capped by `limit`. Jobs without a schedule
 * (on-demand only) and jobs without a computed `next_run_at` are skipped —
 * the cron entrypoint backfills `next_run_at` on insert/post-run so a job
 * appears here exactly once per intended firing.
 */
export async function listDueJobs(env: Env, asOfMs: number, limit = 500): Promise<JobRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM jobs
       WHERE schedule != ''
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
       ORDER BY next_run_at ASC
       LIMIT ?`,
  )
    .bind(asOfMs, limit)
    .all<JobRow>();
  return (rows.results ?? []).map(rowToJob);
}
