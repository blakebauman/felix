/**
 * Source adapters. `nativeSource` wraps an entity's `NativeStore` (used by both
 * `native` and `synced` modes — synced just reads from D1 that a sync job
 * populated). `federatedSource` reads through a connector live, with an
 * optional KV read cache so a hot entity isn't fetched on every request.
 */

import type { Env } from '@felix/orchestrator/env';
import { getEntityConnector } from './connectors';
import type {
  ConnectorConfig,
  EntitySource,
  EntityTypeSpec,
  ListOpts,
  NativeStore,
  Page,
} from './types';

export function nativeSource<T>(
  env: Env,
  tenant: string,
  store: NativeStore<T>,
  mode: 'native' | 'synced' = 'native',
): EntitySource<T> {
  return {
    mode,
    get: (id) => store.get(env, tenant, id),
    list: (opts) => store.list(env, tenant, opts),
  };
}

export function federatedSource<T>(
  env: Env,
  tenant: string,
  spec: EntityTypeSpec<T>,
  cfg: ConnectorConfig,
): EntitySource<T> {
  const connector = getEntityConnector(cfg);
  const ttl = cfg.cache_ttl_seconds ?? 0;
  const cacheKey = (id: string) => `ds:${tenant}:${spec.type}:${id}`;

  async function get(id: string): Promise<T | null> {
    if (ttl > 0 && env.CACHE) {
      const cached = await env.CACHE.get(cacheKey(id), 'json').catch(() => null);
      if (cached) return spec.mapper(cached as Record<string, unknown>, tenant);
    }
    const raw = await connector.fetchOne(spec.type, id, { env, tenant });
    if (!raw) return null;
    if (ttl > 0 && env.CACHE) {
      await env.CACHE.put(cacheKey(id), JSON.stringify(raw), { expirationTtl: ttl }).catch(
        () => {},
      );
    }
    return spec.mapper(raw, tenant);
  }

  async function list(opts?: ListOpts): Promise<Page<T>> {
    const page = await connector.fetchPage(spec.type, opts ?? {}, { env, tenant });
    return {
      items: page.records.map((r) => spec.mapper(r, tenant)),
      ...(page.cursor ? { cursor: page.cursor } : {}),
    };
  }

  return { mode: 'federated', get, list };
}
