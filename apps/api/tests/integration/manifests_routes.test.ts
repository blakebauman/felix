/**
 * /manifests CRUD smoke tests against miniflare D1.
 *
 * Anonymous traffic is permitted in this suite because the test env has no
 * verifiers configured and `ENVIRONMENT=development` — `requireScope`
 * waves the request through. In production a `manifests:write` scope on
 * a verified JWT is required.
 */

import { env, SELF } from 'cloudflare:test';
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
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO manifests (tenant_id, name, version, manifest_json, created_at, created_by, comment)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind('default', 'alpha', 1, JSON.stringify(manifestBody('alpha', 'a')), now, '', ''),
      testEnv.DB.prepare(
        `INSERT INTO manifest_active (tenant_id, name, version, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind('default', 'alpha', 1, now, ''),
    ]);

    const resp = await SELF.fetch('https://orchestrator.test/manifests');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      manifests: Array<{ name: string; active_version: number }>;
    };
    expect(body.manifests.find((m) => m.name === 'alpha')?.active_version).toBe(1);
  });
});
