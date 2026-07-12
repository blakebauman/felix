/**
 * FederationDO — singleton DO that holds the active PolicyBundle. Refreshed
 * from R2 by a cron trigger (see `index.ts:scheduled`) and queryable by
 * any Worker invocation through `idFromName('singleton')`.
 *
 * Holding the bundle in a DO (rather than a module-level variable) lets us
 * push a refresh atomically across the fleet — every isolate fetches from
 * the same DO on cold start.
 */

import type { Env } from '../env';
import { loadFromR2, setActiveBundle } from './bundle';
import type { PolicyBundle } from './models';

interface StoredBundle {
  bundle: PolicyBundle | null;
  refreshedAt: number;
}

export class FederationDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/get') return this.get();
    if (url.pathname === '/refresh') return this.refresh();
    return new Response('not found', { status: 404 });
  }

  private async get(): Promise<Response> {
    const stored = await this.state.storage.get<StoredBundle>('state');
    return Response.json(stored ?? { bundle: null, refreshedAt: 0 });
  }

  private async refresh(): Promise<Response> {
    const bundle = await loadFromR2(this.env);
    const stored: StoredBundle = { bundle, refreshedAt: Date.now() };
    await this.state.storage.put('state', stored);
    return Response.json(stored);
  }
}

export function federationStub(env: Env): DurableObjectStub {
  const id = env.FEDERATION_DO.idFromName('singleton');
  return env.FEDERATION_DO.get(id);
}

/** Pull the current bundle into the in-process cache used by `mergeWithManifest`. */
export async function syncFederationCache(env: Env): Promise<void> {
  const stub = federationStub(env);
  const resp = await stub.fetch('https://do/get');
  if (!resp.ok) return;
  const data = (await resp.json()) as { bundle: PolicyBundle | null };
  setActiveBundle(data.bundle);
}

// Per-isolate throttle so the request path can lazily pull the active bundle
// without a FederationDO round-trip on every build. The cron refresh writes
// the DO; each isolate mirrors it into `activeBundle` at most once per TTL.
let lastSyncAt = 0;
const FEDERATION_SYNC_TTL_MS = 60_000;

/**
 * Ensure this isolate's `activeBundle` reflects the FederationDO, refreshing
 * it at most once per {@link FEDERATION_SYNC_TTL_MS}. Called on the request
 * path (via `buildAgent`) so centrally-distributed policies actually apply —
 * without this, `activeBundle` stays `null` in every request isolate and
 * `mergeWithManifest` silently enforces nothing. Failures keep the previous
 * bundle rather than clearing it.
 */
export async function ensureFederationSynced(env: Env): Promise<void> {
  const now = Date.now();
  if (now - lastSyncAt < FEDERATION_SYNC_TTL_MS) return;
  lastSyncAt = now;
  try {
    await syncFederationCache(env);
  } catch (err) {
    // Keep whatever bundle we already have; a transient DO error must not
    // drop centrally-distributed policies.
    console.warn('federation sync failed; keeping previous bundle', err);
  }
}

/** Test-only: reset the per-isolate sync throttle. */
export function _resetFederationSyncThrottle(): void {
  lastSyncAt = 0;
}
