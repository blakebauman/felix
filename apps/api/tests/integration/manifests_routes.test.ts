/**
 * /manifests CRUD smoke tests against miniflare D1.
 *
 * Anonymous traffic is permitted in this suite because the test env has no
 * verifiers configured and `ENVIRONMENT=development` — `requireScope`
 * waves the request through. In production a `manifests:write` scope on
 * a verified JWT is required.
 */

import { env, SELF } from 'cloudflare:test';
import { getDb } from '@felix/harness/db/client';
import type { Env as AppEnv } from '@felix/harness/env';
import { _clearResolverCache } from '@felix/harness/manifests/resolver';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;

function manifestBody(name: string, description: string): Record<string, unknown> {
  return {
    apiVersion: 'orchestrator/v1',
    kind: 'Agent',
    metadata: { name, version: '1.0.0', description, tags: [] },
    spec: {
      pattern: 'react',
      model: { id: '@cf/meta/llama-3.1-8b-instruct' },
    },
  };
}

/**
 * Kick off an eval run (now 202 + background execution) and poll the run
 * row until it finalizes, returning the terminal record. The eval
 * activation gate only reads `completed` runs, so callers must wait.
 */
async function runEvalAndWait(
  base: string,
  body: Record<string, unknown>,
): Promise<{ id: string; status: string; fail_count: number; manifest_version: number | null }> {
  const resp = await SELF.fetch(`${base}/eval/datasets/gate_set/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(resp.status).toBe(202);
  const { run_id } = (await resp.json()) as { run_id: string };
  for (let i = 0; i < 50; i += 1) {
    const detail = await SELF.fetch(`${base}/eval/runs/${run_id}`);
    expect(detail.status).toBe(200);
    const row = (await detail.json()) as {
      id: string;
      status: string;
      fail_count: number;
      manifest_version: number | null;
    };
    if (row.status !== 'in_progress') return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`eval run ${run_id} did not finalize`);
}

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
});

beforeEach(() => {
  _clearResolverCache();
});

describe('/manifests CRUD', () => {
  it('round-trips create → activate → rollback → delete', async () => {
    // v1
    const created = await SELF.fetch('https://orchestrator.test/manifests/shopping', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: manifestBody('shopping', 'v1'),
        comment: 'initial',
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { version: number; activated: boolean };
    expect(createdBody.version).toBe(1);
    expect(createdBody.activated).toBe(true);

    // v2
    const v2 = await SELF.fetch('https://orchestrator.test/manifests/shopping', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: manifestBody('shopping', 'v2') }),
    });
    expect(v2.status).toBe(201);
    expect(((await v2.json()) as { version: number }).version).toBe(2);

    // GET active = v2
    const active = await SELF.fetch('https://orchestrator.test/manifests/shopping');
    expect(active.status).toBe(200);
    const activeBody = (await active.json()) as {
      source: string;
      version: number | null;
      manifest: { metadata: { description: string } };
    };
    expect(activeBody.source).toBe('tenant_d1');
    expect(activeBody.version).toBe(2);
    expect(activeBody.manifest.metadata.description).toBe('v2');

    // Versions
    const versions = await SELF.fetch('https://orchestrator.test/manifests/shopping/versions');
    const versionsBody = (await versions.json()) as {
      active_version: number;
      versions: Array<{ version: number; active: boolean }>;
    };
    expect(versionsBody.active_version).toBe(2);
    expect(versionsBody.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versionsBody.versions.find((v) => v.version === 2)?.active).toBe(true);

    // Roll back to v1
    const rollback = await SELF.fetch('https://orchestrator.test/manifests/shopping/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1 }),
    });
    expect(rollback.status).toBe(200);
    expect(((await rollback.json()) as { active_version: number }).active_version).toBe(1);

    // Activate refuses unknown version
    const bad = await SELF.fetch('https://orchestrator.test/manifests/shopping/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 99 }),
    });
    expect(bad.status).toBe(404);

    // Can't delete the currently active version
    const deleteActive = await SELF.fetch(
      'https://orchestrator.test/manifests/shopping/versions/1',
      { method: 'DELETE' },
    );
    expect(deleteActive.status).toBe(409);

    // Delete inactive v2 is fine
    const deleteV2 = await SELF.fetch('https://orchestrator.test/manifests/shopping/versions/2', {
      method: 'DELETE',
    });
    expect(deleteV2.status).toBe(200);

    // Wipe out the manifest entirely
    const wipe = await SELF.fetch('https://orchestrator.test/manifests/shopping', {
      method: 'DELETE',
    });
    expect(wipe.status).toBe(200);

    const afterWipe = await SELF.fetch('https://orchestrator.test/manifests/shopping');
    // After wipe the bundled 'shopping' should re-emerge.
    expect(afterWipe.status).toBe(200);
    const afterBody = (await afterWipe.json()) as { source: string };
    expect(afterBody.source).toBe('bundled');
  });

  it('gates activation on a passing eval run when require_eval is set', async () => {
    const base = 'https://orchestrator.test';
    const name = 'gated';
    const manifest = {
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name, version: '1.0.0', description: 'gated', tags: [] },
      spec: {
        pattern: 'react',
        model: { temperature: 0 },
        system_prompt: { inline: 'You are a test agent.' },
        auth: { inbound: { allow_anonymous: true } },
      },
    };

    // v1 (activated), then v2 so we can distinguish versions.
    const c1 = await SELF.fetch(`${base}/manifests/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
    });
    expect(c1.status).toBe(201);
    const c2 = await SELF.fetch(`${base}/manifests/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: { ...manifest, metadata: { ...manifest.metadata, version: '2.0.0' } },
      }),
    });
    expect(c2.status).toBe(201);

    // Empty eval dataset → run completes with zero failures (no model calls).
    await SELF.fetch(`${base}/eval/datasets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'gate_set', description: '' }),
    });
    // Passing run pinned to version 1 (background job polled to terminal).
    const runV1 = await runEvalAndWait(base, {
      candidate_manifest: name,
      candidate_version: 1,
      deterministic_judge: true,
    });
    expect(runV1.status).toBe('completed');
    expect(runV1.fail_count).toBe(0);

    // Passing run pinned to version 2 (used for the version-mismatch case).
    const runV2 = await runEvalAndWait(base, {
      candidate_manifest: name,
      candidate_version: 2,
      deterministic_judge: true,
    });
    expect(runV2.status).toBe('completed');

    // The run records the version it tested.
    expect(runV1.manifest_version).toBe(1);

    // require_eval + a passing run for version 1 → activation succeeds.
    const ok = await SELF.fetch(`${base}/manifests/${name}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, require_eval: true, eval_run_id: runV1.id }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { active_version: number }).active_version).toBe(1);

    // require_eval with no run id → 409.
    const noRun = await SELF.fetch(`${base}/manifests/${name}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, require_eval: true }),
    });
    expect(noRun.status).toBe(409);
    expect(((await noRun.json()) as { error: string }).error).toBe('eval_gate_failed');

    // A run that tested a different version → 409 (version mismatch), even
    // without require_eval — supplying a run id always enforces the gate.
    const mismatch = await SELF.fetch(`${base}/manifests/${name}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, eval_run_id: runV2.id }),
    });
    expect(mismatch.status).toBe(409);
    const mismatchBody = (await mismatch.json()) as { error: string; detail: string };
    expect(mismatchBody.error).toBe('eval_gate_failed');
    expect(mismatchBody.detail).toMatch(/tested version 2, not 1/);

    // An unknown run id → 409.
    const unknown = await SELF.fetch(`${base}/manifests/${name}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, eval_run_id: 'does-not-exist' }),
    });
    expect(unknown.status).toBe(409);

    // Backward compatible: default activation (no gate fields) still works.
    const plain = await SELF.fetch(`${base}/manifests/${name}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2 }),
    });
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as { active_version: number }).active_version).toBe(2);
  });

  it('rejects a name mismatch between URL and metadata.name', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/manifests/foo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: manifestBody('bar', 'mismatch') }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe('name_mismatch');
  });

  it('rejects an invalid manifest payload', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/manifests/broken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { not: 'a manifest' } }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe('validation_failed');
  });

  it('lists active manifests for the tenant', async () => {
    // Seed two manifests directly through D1 so the listing test is
    // independent of the create flow above.
    const now = Date.now();
    const sql = getDb(testEnv);
    await sql`
      INSERT INTO manifests (tenant_id, name, version, manifest_json, created_at, created_by, comment)
        VALUES ('default', 'alpha', 1, ${manifestBody('alpha', 'a')}, ${now}, '', '')
        ON CONFLICT (tenant_id, name, version) DO NOTHING
    `;
    await sql`
      INSERT INTO manifest_active (tenant_id, name, version, updated_at, updated_by)
        VALUES ('default', 'alpha', 1, ${now}, '')
        ON CONFLICT (tenant_id, name) DO UPDATE SET version = excluded.version
    `;

    const resp = await SELF.fetch('https://orchestrator.test/manifests');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      manifests: Array<{ name: string; active_version: number }>;
    };
    expect(body.manifests.find((m) => m.name === 'alpha')?.active_version).toBe(1);
  });
});
