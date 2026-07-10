/**
 * Resolver fallthrough order:
 *   1. tenant D1 active version
 *   2. tenant R2 override (manifests/<tenant>/<name>.json)
 *   3. global R2 override (manifests/<name>.json)
 *   4. bundled
 *
 * Each test installs a fake Env where the layers above the target return
 * "miss" so we can prove the resolver lands on the correct layer.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { _clearResolverCache, resolveManifest } from '../../src/manifests/resolver';

interface FakeD1Row {
  manifest_json?: string;
  version?: number;
  created_at?: number;
  created_by?: string;
  comment?: string;
  updated_at?: number;
  updated_by?: string;
  v?: number | null;
}

type DbHandler = (sql: string, params: unknown[]) => FakeD1Row | null;
type R2Handler = (key: string) => unknown | null;

function buildEnv(opts: { db?: DbHandler; r2?: R2Handler } = {}): Env {
  const db: DbHandler = opts.db ?? (() => null);
  const r2: R2Handler = opts.r2 ?? (() => null);
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              first: async () => db(sql, params),
              all: async () => ({ results: [] }),
              run: async () => ({ meta: { changes: 0 } }),
            };
          },
        };
      },
    },
    BUNDLES: {
      async get(key: string) {
        const hit = r2(key);
        if (!hit) return null;
        return { json: async () => hit };
      },
    },
  } as unknown as Env;
}

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

beforeEach(() => {
  _clearResolverCache();
});

describe('resolveManifest', () => {
  it('returns tenant D1 active version when present', async () => {
    const json = JSON.stringify(manifestBody('shopping', 'tenant-private'));
    const env = buildEnv({
      db(sql) {
        if (sql.includes('FROM manifest_active')) {
          return { version: 3, updated_at: 1, updated_by: '' };
        }
        if (sql.includes('FROM manifests')) {
          return { manifest_json: json, created_at: 1, created_by: '', comment: '' };
        }
        return null;
      },
    });
    const resolved = await resolveManifest(env, 'tenant-a', 'shopping');
    expect(resolved.source).toBe('tenant_d1');
    expect(resolved.version).toBe(3);
    expect(resolved.manifest.metadata.description).toBe('tenant-private');
    expect(resolved.cacheKey).toBe('tenant_d1:tenant-a#shopping#3');
  });

  it('falls through to tenant R2 when D1 has no active row', async () => {
    const env = buildEnv({
      r2(key) {
        if (key === 'manifests/tenant-a/shopping.json') {
          return manifestBody('shopping', 'tenant-r2-override');
        }
        return null;
      },
    });
    const resolved = await resolveManifest(env, 'tenant-a', 'shopping');
    expect(resolved.source).toBe('tenant_r2');
    expect(resolved.manifest.metadata.description).toBe('tenant-r2-override');
  });

  it('falls through to global R2 when tenant layers miss', async () => {
    const env = buildEnv({
      r2(key) {
        if (key === 'manifests/shopping.json') {
          return manifestBody('shopping', 'global-r2-override');
        }
        return null;
      },
    });
    const resolved = await resolveManifest(env, 'tenant-a', 'shopping');
    expect(resolved.source).toBe('global_r2');
    expect(resolved.manifest.metadata.description).toBe('global-r2-override');
  });

  it('falls through to bundled when all overrides miss', async () => {
    const env = buildEnv();
    const resolved = await resolveManifest(env, 'tenant-a', 'quick');
    expect(resolved.source).toBe('bundled');
    expect(resolved.manifest.metadata.name).toBe('quick');
  });

  it('treats the default (anonymous) tenant like any other tenant', async () => {
    // Writes against `default` are only possible in dev (requireScope
    // falls open when no JWT verifiers are configured), but if data has
    // landed there, the resolver should serve it back. The production
    // guarantee that anonymous traffic never sees another tenant's data
    // comes from tenant-scoped WHERE clauses, not from skipping the layer.
    const json = JSON.stringify(manifestBody('quick', 'default-tenant-private'));
    const env = buildEnv({
      db(sql) {
        if (sql.includes('FROM manifest_active')) {
          return { version: 1, updated_at: 0, updated_by: '' };
        }
        if (sql.includes('FROM manifests')) {
          return { manifest_json: json, created_at: 0, created_by: '', comment: '' };
        }
        return null;
      },
    });
    const resolved = await resolveManifest(env, 'default', 'quick');
    expect(resolved.source).toBe('tenant_d1');
    expect(resolved.manifest.metadata.description).toBe('default-tenant-private');
  });

  it('honours pinVersion against tenant D1', async () => {
    const json = JSON.stringify(manifestBody('shopping', 'pinned-v2'));
    const env = buildEnv({
      db(sql, params) {
        if (sql.includes('FROM manifests')) {
          expect(params).toContain(2);
          return { manifest_json: json, created_at: 1, created_by: '', comment: '' };
        }
        return null;
      },
    });
    const resolved = await resolveManifest(env, 'tenant-a', 'shopping', { pinVersion: 2 });
    expect(resolved.source).toBe('tenant_d1');
    expect(resolved.version).toBe(2);
    expect(resolved.manifest.metadata.description).toBe('pinned-v2');
  });

  it('throws when pinVersion targets an unknown version', async () => {
    const env = buildEnv();
    await expect(resolveManifest(env, 'tenant-a', 'shopping', { pinVersion: 99 })).rejects.toThrow(
      /Unknown manifest version/,
    );
  });

  it('throws on a completely unknown manifest name', async () => {
    const env = buildEnv();
    await expect(resolveManifest(env, 'tenant-a', 'does-not-exist')).rejects.toThrow(
      /Unknown manifest/,
    );
  });
});
