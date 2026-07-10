/**
 * Manifest loader.
 *
 * Bundled JSON (built from this repo's manifests/*.yaml via
 * scripts/bundle-manifests.ts) is the default source. At runtime a manifest
 * may also be fetched from R2 under `manifests/<name>.json`; an R2 hit
 * overrides the bundled copy so a deploy can ship a new manifest without
 * a code change.
 *
 * `loadManifest` is sync against the bundled cache and async against R2.
 * Most call sites use the sync form because manifest resolution happens on
 * the hot path of every request.
 */

import type { Env } from '../env';
import { BUNDLED_MANIFEST_NAMES, BUNDLED_MANIFESTS } from './bundled';
import { type Manifest, ManifestSchema } from './schema';

const bundledCache = new Map<string, Manifest>();
const r2Cache = new Map<string, Manifest>();

export function loadManifest(name: string): Manifest {
  const cached = bundledCache.get(name) ?? r2Cache.get(name);
  if (cached) return cached;

  const raw = BUNDLED_MANIFESTS[name];
  if (!raw) {
    throw new Error(`Unknown manifest: ${name}`);
  }
  const parsed = ManifestSchema.parse(raw);
  bundledCache.set(name, parsed);
  return parsed;
}

export async function loadManifestFromR2(env: Env, name: string): Promise<Manifest> {
  const r2Hit = r2Cache.get(name);
  if (r2Hit) return r2Hit;

  const key = `manifests/${name}.json`;
  const obj = await env.BUNDLES.get(key);
  if (!obj) {
    return loadManifest(name);
  }
  const json = await obj.json();
  const parsed = ManifestSchema.parse(json);
  r2Cache.set(name, parsed);
  return parsed;
}

export function listManifests(): string[] {
  return [...BUNDLED_MANIFEST_NAMES];
}

/** Test seam: load directly from a parsed object (used in unit tests). */
export function parseManifest(raw: unknown): Manifest {
  return ManifestSchema.parse(raw);
}

/** Test seam: clear caches (vitest beforeEach). */
export function _clearManifestCaches(): void {
  bundledCache.clear();
  r2Cache.clear();
}
