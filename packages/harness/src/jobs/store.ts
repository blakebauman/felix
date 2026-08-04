/**
 * Job registry (Postgres). Every query is scoped by tenant_id — the table
 * has a composite (tenant_id, name) primary key, matching the rest of the
 * schema.
 */

import { getDb } from '../db/client';
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
  payload_json: Record<string, unknown>;
  enabled: boolean;
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
    payload: row.payload_json ?? {},
    enabled: row.enabled ?? false,
  });
}

export async function listJobs(env: Env, tenantId: string): Promise<JobRecord[]> {
  const sql = getDb(env);
  const rows = await sql<JobRow[]>`
    SELECT * FROM jobs WHERE tenant_id = ${tenantId} ORDER BY name
  `;
  return rows.map(rowToJob);
}

export async function getJob(env: Env, tenantId: string, name: string): Promise<JobRecord | null> {
  const sql = getDb(env);
  const rows = await sql<JobRow[]>`
    SELECT * FROM jobs WHERE tenant_id = ${tenantId} AND name = ${name} LIMIT 1
  `;
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function upsertJob(env: Env, job: JobRecord): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO jobs (tenant_id, name, schedule, manifest_id, last_run_at, next_run_at,
                      last_status, last_error, created_at, payload_json, enabled)
      VALUES (${job.tenant_id}, ${job.name}, ${job.schedule}, ${job.manifest_id},
              ${job.last_run_at ?? null}, ${job.next_run_at ?? null}, ${job.last_status},
              ${job.last_error}, ${job.created_at}, ${job.payload as Record<string, unknown>},
              ${job.enabled})
      ON CONFLICT (tenant_id, name) DO UPDATE SET
        schedule = excluded.schedule,
        manifest_id = excluded.manifest_id,
        next_run_at = excluded.next_run_at,
        payload_json = excluded.payload_json,
        enabled = excluded.enabled
  `;
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
  const sql = getDb(env);
  await sql`
    UPDATE jobs
      SET last_run_at = ${update.last_run_at}, last_status = ${update.last_status},
          last_error = ${update.last_error}, next_run_at = ${update.next_run_at ?? null}
      WHERE tenant_id = ${tenantId} AND name = ${name}
  `;
}

/**
 * Scheduled-sweep view. Returns jobs whose `next_run_at` is at or before
 * `asOfMs` (i.e. due to fire), capped by `limit`. Jobs without a schedule
 * (on-demand only) and jobs without a computed `next_run_at` are skipped —
 * the cron entrypoint backfills `next_run_at` on insert/post-run so a job
 * appears here exactly once per intended firing.
 */
export async function listDueJobs(env: Env, asOfMs: number, limit = 500): Promise<JobRecord[]> {
  const sql = getDb(env);
  const rows = await sql<JobRow[]>`
    SELECT * FROM jobs
      WHERE schedule != ''
        AND next_run_at IS NOT NULL
        AND next_run_at <= ${asOfMs}
      ORDER BY next_run_at ASC
      LIMIT ${limit}
  `;
  return rows.map(rowToJob);
}

/**
 * Claim one firing slot, compare-and-swap style.
 *
 * `next_run_at` doubles as the claim token: the update only lands if the row
 * still shows the value this sweep selected, so when two overlapping ticks see
 * the same due job exactly one wins and the loser skips it. Without this a
 * slow tick overlapping the next one would run the same job twice — harmless
 * while the sweep only bookkept, but not once it invokes a model.
 *
 * Advancing the slot BEFORE the run makes this at-most-once: an isolate that
 * dies mid-run loses that firing rather than repeating it. That is the right
 * bias for work that spends money and may have external side effects; a missed
 * run shows up as a gap in `job_run` audit rows, whereas a duplicated one can
 * be indistinguishable from an intentional second run.
 */
export async function claimJobSlot(
  env: Env,
  tenantId: string,
  name: string,
  expectedNextRunAt: number,
  advancedNextRunAt: number | null,
): Promise<boolean> {
  const sql = getDb(env);
  const rows = await sql<{ name: string }[]>`
    UPDATE jobs
      SET next_run_at = ${advancedNextRunAt}
      WHERE tenant_id = ${tenantId} AND name = ${name}
        AND next_run_at = ${expectedNextRunAt}
      RETURNING name
  `;
  return rows.length > 0;
}
