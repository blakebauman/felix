/**
 * Canary routinghash-bucket variant selection.
 *
 * Pins:
 *   1. `canary_weight === 0` → always stable.
 *   2. `canary_weight === 100` → always canary.
 *   3. With weight > 0 and a threadId, the bucket is deterministic per
 *      `(tenant, thread, manifest, stable_v, canary_v)` tuple.
 *   4. Flipping either version re-randomises the bucket: a thread that
 *      lands on stable for (v1, v2) may land on canary for (v1, v3),
 *      so progressive canaries don't carry old assignments forward.
 *   5. Empty threadId always lands on stable (anonymous requests
 *      shouldn't drift through canary buckets unpredictably).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import { _clearResolverCache, resolveManifest } from '../../src/manifests/resolver';
import type { Manifest } from '../../src/manifests/schema';
import { ManifestSchema } from '../../src/manifests/schema';
import * as store from '../../src/manifests/store';

const baseManifest = ManifestSchema.parse({
  apiVersion: 'orchestrator/v1',
  kind: 'Agent',
  metadata: { name: 'x', version: '1.0.0' },
  spec: {},
});

function makeVersion(manifest: Manifest) {
  return {
    tenant_id: 'acme',
    name: 'x',
    version: 0,
    manifest,
    created_at: 0,
    created_by: '',
    comment: '',
  };
}

const env = {} as unknown as Env;

beforeEach(() => {
  _clearResolverCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canary routing', () => {
  it('returns stable when canary_weight is 0', async () => {
    vi.spyOn(store, 'getActive').mockResolvedValue({
      tenant_id: 'acme',
      name: 'x',
      version: 1,
      canary_version: 2,
      canary_weight: 0,
      updated_at: 0,
      updated_by: '',
    });
    vi.spyOn(store, 'getVersion').mockImplementation(async (_e, _t, _n, v) => ({
      ...makeVersion(baseManifest),
      version: v,
    }));
    const resolved = await resolveManifest(env, 'acme', 'x', { threadId: 'acme:thr-1' });
    expect(resolved.version).toBe(1);
    expect(resolved.variant).toBe('stable');
  });

  it('returns canary when canary_weight is 100', async () => {
    vi.spyOn(store, 'getActive').mockResolvedValue({
      tenant_id: 'acme',
      name: 'x',
      version: 1,
      canary_version: 2,
      canary_weight: 100,
      updated_at: 0,
      updated_by: '',
    });
    vi.spyOn(store, 'getVersion').mockImplementation(async (_e, _t, _n, v) => ({
      ...makeVersion(baseManifest),
      version: v,
    }));
    const resolved = await resolveManifest(env, 'acme', 'x', { threadId: 'acme:thr-1' });
    expect(resolved.version).toBe(2);
    expect(resolved.variant).toBe('canary');
  });

  it('is deterministic per (tenant, thread, manifest, version pair)', async () => {
    vi.spyOn(store, 'getActive').mockResolvedValue({
      tenant_id: 'acme',
      name: 'x',
      version: 1,
      canary_version: 2,
      canary_weight: 50,
      updated_at: 0,
      updated_by: '',
    });
    vi.spyOn(store, 'getVersion').mockImplementation(async (_e, _t, _n, v) => ({
      ...makeVersion(baseManifest),
      version: v,
    }));
    const a = await resolveManifest(env, 'acme', 'x', { threadId: 'acme:thr-1' });
    _clearResolverCache();
    const b = await resolveManifest(env, 'acme', 'x', { threadId: 'acme:thr-1' });
    _clearResolverCache();
    const c = await resolveManifest(env, 'acme', 'x', { threadId: 'acme:thr-1' });
    expect(a.variant).toBe(b.variant);
    expect(b.variant).toBe(c.variant);
  });

  it('returns stable when threadId is omitted (anonymous request)', async () => {
    vi.spyOn(store, 'getActive').mockResolvedValue({
      tenant_id: 'acme',
      name: 'x',
      version: 1,
      canary_version: 2,
      canary_weight: 50,
      updated_at: 0,
      updated_by: '',
    });
    vi.spyOn(store, 'getVersion').mockImplementation(async (_e, _t, _n, v) => ({
      ...makeVersion(baseManifest),
      version: v,
    }));
    const resolved = await resolveManifest(env, 'acme', 'x');
    expect(resolved.variant).toBe('stable');
    expect(resolved.version).toBe(1);
  });

  it('roughly approximates the configured weight across many threads', async () => {
    vi.spyOn(store, 'getActive').mockResolvedValue({
      tenant_id: 'acme',
      name: 'x',
      version: 1,
      canary_version: 2,
      canary_weight: 30,
      updated_at: 0,
      updated_by: '',
    });
    vi.spyOn(store, 'getVersion').mockImplementation(async (_e, _t, _n, v) => ({
      ...makeVersion(baseManifest),
      version: v,
    }));
    let canary = 0;
    const N = 200;
    for (let i = 0; i < N; i += 1) {
      _clearResolverCache();
      const resolved = await resolveManifest(env, 'acme', 'x', {
        threadId: `acme:thr-${i}`,
      });
      if (resolved.variant === 'canary') canary += 1;
    }
    // 30% target ± 10% slack — SHA-256 should be close, but we don't
    // want a flaky test on a 200-sample run.
    const ratio = canary / N;
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.4);
  });

  it('changes bucket assignment when canary_version flips', async () => {
    vi.spyOn(store, 'getVersion').mockImplementation(async (_e, _t, _n, v) => ({
      ...makeVersion(baseManifest),
      version: v,
    }));
    // Same thread, same stable version, different canary version → bucket
    // membership for that one thread changes with non-trivial probability.
    let differs = 0;
    for (let i = 0; i < 50; i += 1) {
      _clearResolverCache();
      const getActive = vi.spyOn(store, 'getActive');
      getActive.mockResolvedValueOnce({
        tenant_id: 'acme',
        name: 'x',
        version: 1,
        canary_version: 2,
        canary_weight: 50,
        updated_at: 0,
        updated_by: '',
      });
      const a = await resolveManifest(env, 'acme', 'x', { threadId: `acme:thr-${i}` });
      _clearResolverCache();
      getActive.mockResolvedValueOnce({
        tenant_id: 'acme',
        name: 'x',
        version: 1,
        canary_version: 3,
        canary_weight: 50,
        updated_at: 0,
        updated_by: '',
      });
      const b = await resolveManifest(env, 'acme', 'x', { threadId: `acme:thr-${i}` });
      if (a.variant !== b.variant) differs += 1;
    }
    // Roughly half should flip when the canary version changes. We use a
    // loose bound to avoid flakiness.
    expect(differs).toBeGreaterThan(10);
  });
});
