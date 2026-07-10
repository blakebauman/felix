/**
 * D1-backed CRUD for eval datasets, items, and runs.
 *
 * Every query is tenant-scoped; the composite primary keys from
 * `0004_eval.sql` enforce that no cross-tenant traffic is possible at
 * the storage layer. The store stays free of business logic — the
 * runner (`src/eval/runner.ts`) and the REST layer (`src/api/eval.ts`)
 * own the "how" and the "why".
 */

import type { Env } from '../env';
import type { EvalDataset, EvalDatasetItem, EvalRun, ItemScore, Rubric } from './types';
import { RubricSchema } from './types';

function parseRubric(raw: string): Rubric {
  try {
    return RubricSchema.parse(JSON.parse(raw));
  } catch {
    return RubricSchema.parse({});
  }
}

function parseScores(raw: string): ItemScore[] {
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data as ItemScore[];
  } catch {
    return [];
  }
}

export async function createDataset(
  env: Env,
  tenantId: string,
  name: string,
  description: string,
): Promise<EvalDataset> {
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO eval_datasets (tenant_id, name, description, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, name) DO UPDATE SET description = excluded.description`,
  )
    .bind(tenantId, name, description, created_at)
    .run();
  return { name, description, created_at };
}

export async function listDatasets(env: Env, tenantId: string): Promise<EvalDataset[]> {
  const rows = await env.DB.prepare(
    `SELECT name, description, created_at
       FROM eval_datasets
       WHERE tenant_id = ?
       ORDER BY created_at DESC`,
  )
    .bind(tenantId)
    .all<{ name: string; description: string; created_at: number }>();
  return rows.results ?? [];
}

export async function getDataset(
  env: Env,
  tenantId: string,
  name: string,
): Promise<EvalDataset | null> {
  const row = await env.DB.prepare(
    `SELECT name, description, created_at
       FROM eval_datasets
       WHERE tenant_id = ? AND name = ?`,
  )
    .bind(tenantId, name)
    .first<{ name: string; description: string; created_at: number }>();
  return row ?? null;
}

export async function addItem(
  env: Env,
  tenantId: string,
  datasetName: string,
  opts: { itemId?: string; userInput: string; rubric: Rubric },
): Promise<EvalDatasetItem> {
  const itemId = opts.itemId ?? crypto.randomUUID();
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO eval_dataset_items
       (tenant_id, dataset_name, item_id, user_input, rubric_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, dataset_name, item_id) DO UPDATE SET
         user_input = excluded.user_input,
         rubric_json = excluded.rubric_json`,
  )
    .bind(tenantId, datasetName, itemId, opts.userInput, JSON.stringify(opts.rubric), created_at)
    .run();
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
  const rows = await env.DB.prepare(
    `SELECT item_id, user_input, rubric_json, created_at
       FROM eval_dataset_items
       WHERE tenant_id = ? AND dataset_name = ?
       ORDER BY created_at ASC`,
  )
    .bind(tenantId, datasetName)
    .all<{ item_id: string; user_input: string; rubric_json: string; created_at: number }>();
  return (rows.results ?? []).map((r) => ({
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
  await env.DB.prepare(
    `INSERT INTO eval_runs
       (tenant_id, id, dataset_name, candidate_manifest, started_at, status,
        pass_count, fail_count, scores_json)
       VALUES (?, ?, ?, ?, ?, 'in_progress', 0, 0, '[]')`,
  )
    .bind(tenantId, id, opts.datasetName, opts.candidateManifest, started_at)
    .run();
  return {
    id,
    dataset_name: opts.datasetName,
    candidate_manifest: opts.candidateManifest,
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
  opts: { status: 'completed' | 'failed'; scores: ItemScore[] },
): Promise<void> {
  const passes = opts.scores.filter((s) => s.verdict === 'pass').length;
  const fails = opts.scores.length - passes;
  await env.DB.prepare(
    `UPDATE eval_runs
        SET status = ?, finished_at = ?, pass_count = ?, fail_count = ?, scores_json = ?
        WHERE tenant_id = ? AND id = ?`,
  )
    .bind(opts.status, Date.now(), passes, fails, JSON.stringify(opts.scores), tenantId, runId)
    .run();
}

export async function getRun(env: Env, tenantId: string, runId: string): Promise<EvalRun | null> {
  const row = await env.DB.prepare(
    `SELECT id, dataset_name, candidate_manifest, started_at, finished_at,
            status, pass_count, fail_count, scores_json
       FROM eval_runs
       WHERE tenant_id = ? AND id = ?`,
  )
    .bind(tenantId, runId)
    .first<{
      id: string;
      dataset_name: string;
      candidate_manifest: string;
      started_at: number;
      finished_at: number | null;
      status: string;
      pass_count: number;
      fail_count: number;
      scores_json: string;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    dataset_name: row.dataset_name,
    candidate_manifest: row.candidate_manifest,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status as EvalRun['status'],
    pass_count: row.pass_count,
    fail_count: row.fail_count,
    scores: parseScores(row.scores_json),
  };
}

export async function listRuns(
  env: Env,
  tenantId: string,
  opts: { datasetName?: string; limit?: number } = {},
): Promise<EvalRun[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const sql = `
    SELECT id, dataset_name, candidate_manifest, started_at, finished_at,
           status, pass_count, fail_count, scores_json
      FROM eval_runs
      WHERE tenant_id = ?
        ${opts.datasetName ? 'AND dataset_name = ?' : ''}
      ORDER BY started_at DESC
      LIMIT ?
  `;
  const binds: unknown[] = [tenantId];
  if (opts.datasetName) binds.push(opts.datasetName);
  binds.push(limit);
  const rows = await env.DB.prepare(sql)
    .bind(...binds)
    .all<{
      id: string;
      dataset_name: string;
      candidate_manifest: string;
      started_at: number;
      finished_at: number | null;
      status: string;
      pass_count: number;
      fail_count: number;
      scores_json: string;
    }>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    dataset_name: row.dataset_name,
    candidate_manifest: row.candidate_manifest,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status as EvalRun['status'],
    pass_count: row.pass_count,
    fail_count: row.fail_count,
    scores: parseScores(row.scores_json),
  }));
}
