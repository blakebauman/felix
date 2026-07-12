/**
 * Regression (audit H1): federation PolicyBundles were enforced NOWHERE on the
 * request path. `syncFederationCache` — the function that mirrors the
 * FederationDO's bundle into a request isolate's module-level `activeBundle` —
 * had zero call sites, so `activeBundle` was permanently `null` in every
 * request isolate and `mergeWithManifest` silently returned only the
 * manifest's own policies. A signed central bundle adding `required_scopes`
 * or overriding a manifest policy applied to nothing.
 *
 * Pins:
 *   1. `ensureFederationSynced` pulls the DO's bundle into `activeBundle`.
 *   2. Once synced, `mergeWithManifest` applies bundle policies (and the
 *      bundle wins on id collision).
 *   3. The per-isolate TTL throttle suppresses repeat DO round-trips.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { getActiveBundle, mergeWithManifest, setActiveBundle } from '../../src/policy/bundle';
import {
  _resetFederationSyncThrottle,
  ensureFederationSynced,
} from '../../src/policy/federation-do';

function envWithBundle(bundle: unknown, onFetch: () => void): Env {
  return {
    FEDERATION_DO: {
      idFromName: () => ({}),
      get: () => ({
        async fetch() {
          onFetch();
          return Response.json({ bundle, refreshedAt: 1 });
        },
      }),
    },
  } as unknown as Env;
}

const BUNDLE = {
  version: 'v1',
  policies: [{ id: 'central-1', tools: ['*'], required_scopes: ['admin'] }],
  approvals: [],
};

afterEach(() => {
  setActiveBundle(null);
  _resetFederationSyncThrottle();
});

describe('federation sync into request isolates', () => {
  it('mirrors the DO bundle into activeBundle', async () => {
    let fetches = 0;
    const env = envWithBundle(BUNDLE, () => {
      fetches += 1;
    });
    expect(getActiveBundle()).toBeNull();
    await ensureFederationSynced(env);
    expect(getActiveBundle()?.version).toBe('v1');
    expect(fetches).toBe(1);
  });

  it('applies bundle policies in mergeWithManifest once synced (bundle wins on id)', async () => {
    const env = envWithBundle(BUNDLE, () => {});
    await ensureFederationSynced(env);
    const manifestPolicies = [{ id: 'central-1', tools: ['x'], required_scopes: [] }] as never;
    const merged = mergeWithManifest(manifestPolicies, []);
    const central = merged.policies.find((p) => p.id === 'central-1');
    // Bundle override wins the id collision — its required_scopes survive.
    expect(central?.required_scopes).toEqual(['admin']);
  });

  it('throttles repeat syncs within the TTL window', async () => {
    let fetches = 0;
    const env = envWithBundle(BUNDLE, () => {
      fetches += 1;
    });
    await ensureFederationSynced(env);
    await ensureFederationSynced(env);
    await ensureFederationSynced(env);
    expect(fetches).toBe(1);
  });
});
