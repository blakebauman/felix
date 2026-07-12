/**
 * /eval REST surface — dataset CRUD, items, runs.
 *
 * We avoid driving an actual candidate-manifest invocation here: the
 * workers test env doesn't bind a real `AI` and the bundled manifests
 * route through AI Gateway. The runner contract — regression detection
 * — is unit-tested separately in `tests/unit/eval_runner.test.ts`.
 *
 * What this file pins:
 *   - dataset create / list / get
 *   - item add / list, idempotent on item_id
 *   - run on an empty dataset is ACCEPTED (202, non-terminal) and the
 *     background job finalizes it to completed / 0 / 0 (no model calls)
 *   - run / runs list / get retrieves the stored row
 */

import { env, SELF } from 'cloudflare:test';
import type { Env as AppEnv } from '@felix/harness/env';
import { describe, expect, it } from 'vitest';

const testEnv = env as unknown as AppEnv;

interface RunRow {
  id: string;
  status: string;
  pass_count: number;
  fail_count: number;
  dataset_name: string;
}

/**
 * Poll `GET /eval/runs/{id}` until the background job moves the row out of
 * `in_progress`. The run route now returns 202 and finalizes the row via
 * `execCtx.waitUntil` — the empty-dataset case has no model calls so it
 * settles almost immediately, but we poll to keep the test deterministic.
 */
async function pollRun(runId: string, tries = 50): Promise<RunRow> {
  for (let i = 0; i < tries; i += 1) {
    const resp = await SELF.fetch(`https://orchestrator.test/eval/runs/${runId}`);
    expect(resp.status).toBe(200);
    const row = (await resp.json()) as RunRow;
    if (row.status !== 'in_progress') return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`run ${runId} did not finalize`);
}

describe('/eval datasets + items', () => {
  it('creates, lists, and fetches a dataset', async () => {
    const created = await SELF.fetch('https://orchestrator.test/eval/datasets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'smoke', description: 'baseline regressions' }),
    });
    expect(created.status).toBe(201);

    const list = await SELF.fetch('https://orchestrator.test/eval/datasets');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { datasets: Array<{ name: string }> };
    expect(listBody.datasets.some((d) => d.name === 'smoke')).toBe(true);

    const get = await SELF.fetch('https://orchestrator.test/eval/datasets/smoke');
    expect(get.status).toBe(200);
    const ds = (await get.json()) as { name: string; description: string };
    expect(ds).toMatchObject({ name: 'smoke', description: 'baseline regressions' });
  });

  it('adds and lists items, deduping on item_id', async () => {
    // Create the dataset first (idempotent).
    await SELF.fetch('https://orchestrator.test/eval/datasets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'items_test', description: '' }),
    });

    const add = await SELF.fetch('https://orchestrator.test/eval/datasets/items_test/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        item_id: 'q1',
        user_input: 'What is the capital of France?',
        rubric: {
          criteria: 'response identifies Paris',
          must_include: ['paris'],
          must_not_include: [],
          pass_threshold: 0.7,
        },
      }),
    });
    expect(add.status).toBe(201);

    // Re-upsert the same item — should not duplicate.
    await SELF.fetch('https://orchestrator.test/eval/datasets/items_test/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        item_id: 'q1',
        user_input: 'edited question',
        rubric: {
          criteria: '',
          must_include: ['paris'],
          must_not_include: [],
          pass_threshold: 0.7,
        },
      }),
    });

    const list = await SELF.fetch('https://orchestrator.test/eval/datasets/items_test/items');
    const listBody = (await list.json()) as {
      items: Array<{ item_id: string; user_input: string }>;
    };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]).toMatchObject({ item_id: 'q1', user_input: 'edited question' });
  });

  it('rejects items targeting a missing dataset with 404', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/eval/datasets/missing/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_input: 'x',
        rubric: { criteria: '', must_include: [], must_not_include: [], pass_threshold: 0.7 },
      }),
    });
    expect(resp.status).toBe(404);
  });
});

describe('/eval runs', () => {
  it('accepts a run (202, non-terminal) and the background job finalizes it', async () => {
    // Create dataset with no items — runner short-circuits with 0/0.
    await SELF.fetch('https://orchestrator.test/eval/datasets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'empty_set', description: '' }),
    });

    const run = await SELF.fetch('https://orchestrator.test/eval/datasets/empty_set/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidate_manifest: 'quick', deterministic_judge: true }),
    });
    // The route returns immediately: run created, execution deferred to a
    // background job. The body reports the id and a non-terminal status.
    expect(run.status).toBe(202);
    const accepted = (await run.json()) as { run_id: string; status: string };
    expect(typeof accepted.run_id).toBe('string');
    expect(accepted.status).toBe('in_progress');

    // A separate step drains the background job to a terminal state.
    const row = await pollRun(accepted.run_id);
    expect(row).toMatchObject({
      id: accepted.run_id,
      status: 'completed',
      pass_count: 0,
      fail_count: 0,
      dataset_name: 'empty_set',
    });

    const list = await SELF.fetch('https://orchestrator.test/eval/runs?dataset=empty_set&limit=10');
    const listBody = (await list.json()) as { runs: Array<{ id: string }> };
    expect(listBody.runs.some((r) => r.id === accepted.run_id)).toBe(true);
  });

  it('404s on a run id that does not exist for this tenant', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/eval/runs/does-not-exist');
    expect(resp.status).toBe(404);
  });
});
