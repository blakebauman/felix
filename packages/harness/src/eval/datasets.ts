/**
 * Postgres-backed CRUD for eval datasets, items, and runs.
 *
 * Every query is tenant-scoped; the composite primary keys enforce that no
 * cross-tenant traffic is possible at the storage layer. The store stays
 * free of business logic — the runner (`src/eval/runner.ts`) and the REST
 * layer (`src/api/eval.ts`) own the "how" and the "why".
 */

import { getDb } from '../db/client';
import type { Env } from '../env';
import type { EvalDataset, EvalDatasetItem, EvalRun, ItemScore, Rubric } from './types';
import { RubricSchema } from './types';

function parseRubric(raw: unknown): Rubric {
  try {
    return RubricSchema.parse(raw);
  } catch {
    return RubricSchema.parse({});
  }
}

function parseScores(raw: unknown): ItemScore[] {
  return Array.isArray(raw) ? (raw as ItemScore[]) : [];
}

export async function createDataset(
  env: Env,
  tenantId: string,
  name: string,
  description: string,
): Promise<EvalDataset> {
  const created_at = Date.now();
  const sql = getDb(env);
  await sql`
    INSERT INTO eval_datasets (tenant_id, name, description, created_at)
      VALUES (${tenantId}, ${name}, ${description}, ${created_at})
      ON CONFLICT (tenant_id, name) DO UPDATE SET description = excluded.description
  `;
  return { name, description, created_at };
}

export async function listDatasets(env: Env, tenantId: string): Promise<EvalDataset[]> {
  const sql = getDb(env);
  const rows = await sql<{ name: string; description: string; created_at: number }[]>`
    SELECT name, description, created_at
      FROM eval_datasets
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
  `;
  return rows.map((r) => ({ ...r }));
}

export async function getDataset(
  env: Env,
  tenantId: string,
  name: string,
): Promise<EvalDataset | null> {
  const sql = getDb(env);
  const rows = await sql<{ name: string; description: string; created_at: number }[]>`
    SELECT name, description, created_at
      FROM eval_datasets
      WHERE tenant_id = ${tenantId} AND name = ${name}
  `;
  return rows[0] ? { ...rows[0] } : null;
}

export async function addItem(
  env: Env,
  tenantId: string,
  datasetName: string,
  opts: { itemId?: string; userInput: string; rubric: Rubric },
): Promise<EvalDatasetItem> {
  const itemId = opts.itemId ?? crypto.randomUUID();
  const created_at = Date.now();
  const sql = getDb(env);
  await sql`
    INSERT INTO eval_dataset_items
      (tenant_id, dataset_name, item_id, user_input, rubric_json, created_at)
      VALUES (${tenantId}, ${datasetName}, ${itemId}, ${opts.userInput},
              ${opts.rubric as Record<string, unknown>}, ${created_at})
      ON CONFLICT (tenant_id, dataset_name, item_id) DO UPDATE SET
        user_input = excluded.user_input,
        rubric_json = excluded.rubric_json
  `;
  return {
    dataset_name: datasetName,
    item_id: itemId,
    user_input: opts.userInput,
    rubric: opts.rubric,
    created_at,
  };
}

export async function listItems(
  env: Env,
  tenantId: string,
  datasetName: string,
): Promise<EvalDatasetItem[]> {
  const sql = getDb(env);
  const rows = await sql<
    { item_id: string; user_input: string; rubric_json: unknown; created_at: number }[]
  >`
    SELECT item_id, user_input, rubric_json, created_at
      FROM eval_dataset_items
      WHERE tenant_id = ${tenantId} AND dataset_name = ${datasetName}
      ORDER BY created_at ASC
  `;
  return rows.map((r) => ({
    dataset_name: datasetName,
    item_id: r.item_id,
    user_input: r.user_input,
    rubric: parseRubric(r.rubric_json),
    created_at: r.created_at,
  }));
}

export async function createRun(
  env: Env,
  tenantId: string,
  opts: { datasetName: string; candidateManifest: string },
): Promise<EvalRun> {
  const id = crypto.randomUUID();
  const started_at = Date.now();
  const sql = getDb(env);
  await sql`
    INSERT INTO eval_runs
      (tenant_id, id, dataset_name, candidate_manifest, started_at, status,
       pass_count, fail_count, scores_json)
      VALUES (${tenantId}, ${id}, ${opts.datasetName}, ${opts.candidateManifest},
              ${started_at}, 'in_progress', 0, 0, '[]')
  `;
  return {
    id,
    dataset_name: opts.datasetName,
    candidate_manifest: opts.candidateManifest,
    manifest_version: null,
    started_at,
    finished_at: null,
    status: 'in_progress',
    pass_count: 0,
    fail_count: 0,
    scores: [],
  };
}

export async function finalizeRun(
  env: Env,
  tenantId: string,
  runId: string,
  opts: {
    status: 'completed' | 'failed';
    scores: ItemScore[];
    /**
     * The tenant-managed version the run tested (from the resolver). Written
     * so the activation gate can match a passing run to the exact version.
     * `undefined` leaves the column untouched; `null` clears it.
     */
    manifestVersion?: number | null;
  },
): Promise<void> {
  const passes = opts.scores.filter((s) => s.verdict === 'pass').length;
  const fails = opts.scores.length - passes;
  const sql = getDb(env);
  await sql`
    UPDATE eval_runs
      SET status = ${opts.status}, finished_at = ${Date.now()}, pass_count = ${passes},
          fail_count = ${fails}, scores_json = ${opts.scores as unknown as Record<string, unknown>[]},
          manifest_version = ${opts.manifestVersion ?? null}
      WHERE tenant_id = ${tenantId} AND id = ${runId}
  `;
}

interface RunRow {
  id: string;
  dataset_name: string;
  candidate_manifest: string;
  manifest_version: number | null;
  started_at: number;
  finished_at: number | null;
  status: string;
  pass_count: number;
  fail_count: number;
  scores_json: unknown;
}

function rowToRun(row: RunRow): EvalRun {
  return {
    id: row.id,
    dataset_name: row.dataset_name,
    candidate_manifest: row.candidate_manifest,
    manifest_version: row.manifest_version,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status as EvalRun['status'],
    pass_count: row.pass_count,
    fail_count: row.fail_count,
    scores: parseScores(row.scores_json),
  };
}

export async function getRun(env: Env, tenantId: string, runId: string): Promise<EvalRun | null> {
  const sql = getDb(env);
  const rows = await sql<RunRow[]>`
    SELECT id, dataset_name, candidate_manifest, manifest_version, started_at, finished_at,
           status, pass_count, fail_count, scores_json
      FROM eval_runs
      WHERE tenant_id = ${tenantId} AND id = ${runId}
  `;
  return rows[0] ? rowToRun(rows[0]) : null;
}

export async function listRuns(
  env: Env,
  tenantId: string,
  opts: { datasetName?: string; limit?: number } = {},
): Promise<EvalRun[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const sql = getDb(env);
  const rows = await sql<RunRow[]>`
    SELECT id, dataset_name, candidate_manifest, manifest_version, started_at, finished_at,
           status, pass_count, fail_count, scores_json
      FROM eval_runs
      WHERE tenant_id = ${tenantId}
      ${opts.datasetName ? sql`AND dataset_name = ${opts.datasetName}` : sql``}
      ORDER BY started_at DESC
      LIMIT ${limit}
  `;
  return rows.map(rowToRun);
}
