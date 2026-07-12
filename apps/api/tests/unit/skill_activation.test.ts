/**
 * Validation behaviour of the activate_skill / deactivate_skill / list_skills
 * tools wired in composition.ts. These tests cover the rejection paths
 * (unknown manifest, missing manifest_id, skill not declared) — the
 * handlers short-circuit before touching the database, so the env stub
 * never has to implement a real one; a fake sql client (empty on every
 * query) is injected via RequestContext.db so the resolver's tenant
 * Postgres layer cleanly misses and falls through to the bundled layer.
 *
 * The happy-path (activate → persist → read back) is covered in the
 * integration suite where miniflare provides a real Postgres (Hyperdrive).
 */

import { ANONYMOUS } from '@felix/harness/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '@felix/harness/context';
import type { Env } from '@felix/harness/env';
import { _clearResolverCache } from '@felix/harness/manifests/resolver';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeFakeSql } from '../../../../packages/harness/tests/helpers/fake-sql';
import { compose } from '../../src/composition';

/**
 * Minimal env stub: the resolver reaches for a Postgres client (injected
 * per call via RequestContext.db in `ctx()` below) and `env.BUNDLES` (R2
 * override). Both are stubbed to "miss" so resolution falls through to the
 * bundled layer, matching the pre-resolver behaviour these tests were
 * written against.
 */
function fakeEnv(): Env {
  return {
    BUNDLES: { get: async () => null },
  } as unknown as Env;
}

beforeEach(() => {
  _clearResolverCache();
});

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  const { sql } = makeFakeSql(() => []);
  return {
    env: fakeEnv(),
    auth: { ...ANONYMOUS, principal: { ...ANONYMOUS.principal, tenantId: 't1' } },
    limitState: newLimitState(),
    db: sql,
    ...overrides,
  };
}

describe('skill activation tools — validation', () => {
  const provider = compose(fakeEnv());

  it('activate_skill rejects when manifest_id is missing', async () => {
    const [tool] = provider.resolve(['activate_skill']);
    const out = await runWithContext(ctx(), () => tool!.executor.execute({ skill: 'foo' }));
    expect(String(out)).toContain('manifest_id required');
  });

  it('activate_skill rejects an unknown manifest', async () => {
    const [tool] = provider.resolve(['activate_skill']);
    const out = await runWithContext(ctx(), () =>
      tool!.executor.execute({ skill: 'foo', manifest_id: 'does-not-exist' }),
    );
    expect(String(out)).toContain('unknown manifest');
  });

  it('activate_skill rejects a skill not declared in the manifest', async () => {
    // `quick` is a bundled manifest that declares no skills, so any skill
    // name passes the unknown-manifest check but fails the declaration
    // check — exactly the path we want to confirm.
    const [tool] = provider.resolve(['activate_skill']);
    const out = await runWithContext(ctx({ manifestId: 'quick' }), () =>
      tool!.executor.execute({ skill: 'not-declared' }),
    );
    expect(String(out)).toContain("'not-declared' is not declared in manifest 'quick'");
  });

  it('list_skills returns the manifest-declared list, not the global catalog', async () => {
    const [tool] = provider.resolve(['list_skills']);
    const out = await runWithContext(ctx({ manifestId: 'quick' }), () =>
      tool!.executor.execute({}),
    );
    const parsed = JSON.parse(String(out));
    expect(parsed).toMatchObject({
      declared: [],
      active: null,
      mode: expect.stringContaining('no overlay'),
    });
  });

  it('deactivate_skill is a no-op against an unknown manifest', async () => {
    const [tool] = provider.resolve(['deactivate_skill']);
    const out = await runWithContext(ctx(), () =>
      tool!.executor.execute({ skill: 'foo', manifest_id: 'does-not-exist' }),
    );
    expect(String(out)).toContain('unknown manifest');
  });
});
