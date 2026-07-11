/**
 * Tenant-aware manifest resolver. The request-path replacement for
 * `loadManifest` — accepts a tenantId and walks the override chain:
 *
 *   1. tenant D1 active version  (manifest_active → manifests rows)
 *   2. tenant R2 override        (manifests/<tenant_id>/<name>.json)
 *   3. global R2 override        (manifests/<name>.json — existing path)
 *   4. bundled manifest          (BUNDLED_MANIFESTS[name])
 *
 * A caller-supplied `pinVersion` short-circuits step 1 to a specific
 * tenant version (used by `x-manifest-version` for canary/diagnostic).
 *
 * Sync `loadManifest` is preserved for system-only call sites that have no
 * tenant context (cron, A2A discovery card, MCP default). Request handlers
 * should use this resolver so per-tenant overrides take effect.
 */

import type { Env } from '../env';
import { BUNDLED_MANIFESTS } from './bundled';
import { type Manifest, ManifestSchema } from './schema';
import { getActive, getVersion } from './store';

export type ManifestSource = 'tenant_d1' | 'tenant_r2' | 'global_r2' | 'bundled';

export type ManifestVariant = 'stable' | 'canary';

export interface ResolvedManifest {
  manifest: Manifest;
  source: ManifestSource;
  /** Set only when `source === 'tenant_d1'`. */
  version?: number;
  /**
   * `'canary'` when the manifest_active row had `canary_version` set,
   * `canary_weight > 0`, and the thread's hash bucket landed below the
   * weight. Otherwise `'stable'` (or undefined for non-tenant-D1
   * resolutions where canary isn't a concept). The chat / openai-compat
   * routes surface this as the `x-manifest-variant` response header so
   * an operator can verify a canary is reaching real traffic.
   */
  variant?: ManifestVariant;
  /** Stable key for downstream caches (per-isolate agent builds). */
  cacheKey: string;
}

export interface ResolveOptions {
  pinVersion?: number;
  /**
   * Optional thread id used for deterministic canary bucketing. A
   * thread always lands on the same variant for a given (stable,
   * canary) version pair — flipping either version re-randomises the
   * bucket. Anonymous requests without a thread id always land on the
   * stable side.
   */
  threadId?: string;
}

// Tenant D1 version blobs are immutable; cache them per isolate forever.
const versionBlobCache = new Map<string, Manifest>();
// The active-version pointer is the only mutable bit. Cache it briefly so
// the hot path doesn't re-query D1 on every request — 30s is short enough
// to keep flips visible without becoming a thundering herd on D1.
const ACTIVE_TTL_MS = 30_000;
const activePointerCache = new Map<
  string,
  { version: number; canary_version: number | null; canary_weight: number; expiresAt: number }
>();
// Tenant R2 hits are immutable per (tenant, name) at object-version level,
// but we don't track R2 etags here — store the parsed manifest for the
// isolate's lifetime, same lease as the existing global r2Cache.
const tenantR2Cache = new Map<string, Manifest>();
// Global R2 reuse: this resolver does its own R2 GET so it can distinguish
// "tenant R2 miss" from "global R2 miss" for cacheKey purposes.
const globalR2Cache = new Map<string, Manifest>();

function blobKey(tenantId: string, name: string, version: number): string {
  return `${tenantId}#${name}#${version}`;
}

function pointerKey(tenantId: string, name: string): string {
  return `${tenantId}#${name}`;
}

interface ActivePointer {
  version: number;
  canary_version: number | null;
  canary_weight: number;
}

/**
 * Map a (tenant, thread, manifest, stable_v, canary_v) tuple onto a
 * `'stable' | 'canary'` variant. Deterministic per tuple so a single
 * thread stays on one side across the rollout; flipping either version
 * number re-randomises the bucket.
 *
 * Hashing uses SHA-256 (Web Crypto, available in workerd) — overkill
 * for a bucket selector but it's what's portably available without
 * adding a hash dependency. Modular arithmetic on the first 4 bytes
 * gives a stable 0..99 bucket.
 */
async function pickVariant(opts: {
  tenantId: string;
  threadId: string;
  manifestName: string;
  stableVersion: number;
  canaryVersion: number;
  canaryWeight: number;
}): Promise<ManifestVariant> {
  if (opts.canaryWeight <= 0) return 'stable';
  if (opts.canaryWeight >= 100) return 'canary';
  if (!opts.threadId) return 'stable';
  const key = `${opts.tenantId}|${opts.threadId}|${opts.manifestName}|${opts.stableVersion}|${opts.canaryVersion}`;
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new DataView(digest);
  const bucket = view.getUint32(0, false) % 100;
  return bucket < opts.canaryWeight ? 'canary' : 'stable';
}

async function readTenantD1(
  env: Env,
  tenantId: string,
  name: string,
  opts: ResolveOptions,
): Promise<ResolvedManifest | null> {
  let pointer: ActivePointer;
  if (opts.pinVersion != null) {
    // An explicit pin bypasses the active-pointer + canary routing
    // entirely — the caller asked for one specific blob.
    pointer = { version: opts.pinVersion, canary_version: null, canary_weight: 0 };
  } else {
    const cached = activePointerCache.get(pointerKey(tenantId, name));
    if (cached && cached.expiresAt > Date.now()) {
      pointer = {
        version: cached.version,
        canary_version: cached.canary_version,
        canary_weight: cached.canary_weight,
      };
    } else {
      const active = await getActive(env, tenantId, name);
      if (!active) {
        // Negative result is intentionally NOT cached — we want the next
        // POST to be visible immediately. The fallback layers below run on
        // every miss; their own caches absorb the cost.
        return null;
      }
      pointer = {
        version: active.version,
        canary_version: active.canary_version,
        canary_weight: active.canary_weight,
      };
      activePointerCache.set(pointerKey(tenantId, name), {
        ...pointer,
        expiresAt: Date.now() + ACTIVE_TTL_MS,
      });
    }
  }

  // Pick variant once the pointer is in hand; for pinned versions we
  // always report stable since the caller bypassed the canary path.
  let variant: ManifestVariant = 'stable';
  let resolvedVersion = pointer.version;
  if (opts.pinVersion == null && pointer.canary_version != null && pointer.canary_weight > 0) {
    variant = await pickVariant({
      tenantId,
      threadId: opts.threadId ?? '',
      manifestName: name,
      stableVersion: pointer.version,
      canaryVersion: pointer.canary_version,
      canaryWeight: pointer.canary_weight,
    });
    if (variant === 'canary') resolvedVersion = pointer.canary_version;
  }

  const cachedBlob = versionBlobCache.get(blobKey(tenantId, name, resolvedVersion));
  if (cachedBlob) {
    return {
      manifest: cachedBlob,
      source: 'tenant_d1',
      version: resolvedVersion,
      variant,
      cacheKey: `tenant_d1:${tenantId}#${name}#${resolvedVersion}`,
    };
  }
  const row = await getVersion(env, tenantId, name, resolvedVersion);
  if (!row) return null;
  versionBlobCache.set(blobKey(tenantId, name, resolvedVersion), row.manifest);
  return {
    manifest: row.manifest,
    source: 'tenant_d1',
    version: resolvedVersion,
    variant,
    cacheKey: `tenant_d1:${tenantId}#${name}#${resolvedVersion}`,
  };
}

async function readR2(
  env: Env,
  key: string,
  cache: Map<string, Manifest>,
): Promise<Manifest | null> {
  const cached = cache.get(key);
  if (cached) return cached;
  const obj = await env.BUNDLES.get(key);
  if (!obj) return null;
  const parsed = ManifestSchema.parse(await obj.json());
  cache.set(key, parsed);
  return parsed;
}

function readBundled(name: string): Manifest | null {
  const raw = BUNDLED_MANIFESTS[name];
  if (!raw) return null;
  return ManifestSchema.parse(raw);
}

export async function resolveManifest(
  env: Env,
  tenantId: string,
  name: string,
  opts: ResolveOptions = {},
): Promise<ResolvedManifest> {
  const tenantD1 = await readTenantD1(env, tenantId, name, opts);
  if (tenantD1) return tenantD1;

  // A version pin only makes sense against the tenant's own D1 store. If
  // pinned and missing, do NOT fall through — surface a hard error so
  // callers don't silently get a different blob.
  if (opts.pinVersion != null) {
    throw new Error(`Unknown manifest version: ${name}@${opts.pinVersion}`);
  }

  const tenantR2 = await readR2(env, `manifests/${tenantId}/${name}.json`, tenantR2Cache);
  if (tenantR2) {
    return {
      manifest: tenantR2,
      source: 'tenant_r2',
      cacheKey: `tenant_r2:${tenantId}#${name}`,
    };
  }

  const globalR2 = await readR2(env, `manifests/${name}.json`, globalR2Cache);
  if (globalR2) {
    return {
      manifest: globalR2,
      source: 'global_r2',
      cacheKey: `global_r2:${name}`,
    };
  }

  const bundled = readBundled(name);
  if (bundled) {
    return {
      manifest: bundled,
      source: 'bundled',
      cacheKey: `bundled:${name}`,
    };
  }

  throw new Error(`Unknown manifest: ${name}`);
}

/**
 * Force-invalidate the active-version pointer cache for a (tenant, name).
 * Call after a write so the next read sees the new pointer immediately
 * instead of waiting up to ACTIVE_TTL_MS. The blob cache is unaffected —
 * version rows are immutable so they remain valid.
 */
export function invalidateActive(tenantId: string, name: string): void {
  activePointerCache.delete(pointerKey(tenantId, name));
}

/** Test seam: drop all in-memory resolver caches (vitest beforeEach). */
export function _clearResolverCache(): void {
  versionBlobCache.clear();
  activePointerCache.clear();
  tenantR2Cache.clear();
  globalR2Cache.clear();
}
