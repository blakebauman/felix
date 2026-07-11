/**
 * Entity data-source seam — types.
 *
 * The harness already virtualizes tools (transport seam), sessions, models,
 * and manifests. This adds the same treatment to *data*: any entity type can
 * be resolved from native D1 (default) or a 3p integration, without callers
 * knowing which. A caller asks `resolveEntitySource(env, tenant, type)` for an
 * `EntitySource<T>` and reads through it.
 *
 *   native    — D1 is the source of truth (CRUD via the entity's NativeStore).
 *   federated — read-through to an `EntityConnector` live; external owns it.
 *   synced    — reads are native (D1); a pull job / webhook populates D1 from
 *               a connector. Reads look identical to native.
 */

import type { Env } from '@felix/harness/env';

export type EntityMode = 'native' | 'federated' | 'synced';

/** A raw record as returned by a connector before mapping to a typed entity. */
export type RawRecord = Record<string, unknown>;

export interface ListOpts {
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  cursor?: string;
}

/** Read interface every source exposes, regardless of where the data lives. */
export interface EntitySource<T> {
  readonly mode: EntityMode;
  get(id: string): Promise<T | null>;
  list(opts?: ListOpts): Promise<Page<T>>;
}

/**
 * Native store for an entity type — the D1 implementation. `synced` mode reads
 * through this too (the sync path writes via `upsert`).
 */
export interface NativeStore<T> {
  get(env: Env, tenant: string, id: string): Promise<T | null>;
  list(env: Env, tenant: string, opts?: ListOpts): Promise<Page<T>>;
  upsert(env: Env, tenant: string, entity: T): Promise<void>;
}

/**
 * Connector to a 3p system. Returns raw records; the entity type's `mapper`
 * turns them into typed entities. Built-ins: `http`, `mcp` (see connectors.ts).
 */
export interface EntityConnector {
  readonly kind: string;
  fetchOne(type: string, id: string, ctx: ConnectorCtx): Promise<RawRecord | null>;
  fetchPage(
    type: string,
    opts: ListOpts,
    ctx: ConnectorCtx,
  ): Promise<{ records: RawRecord[]; cursor?: string }>;
}

export interface ConnectorCtx {
  env: Env;
  tenant: string;
  signal?: AbortSignal;
}

/** Connector configuration persisted in `data_sources.connector_json`. */
export interface ConnectorConfig {
  kind: string; // 'http' | 'mcp' | custom
  url: string;
  /** Auth marker resolved by the outbound broker, or a literal `Bearer …`. */
  auth?: string;
  /** Optional per-connector knobs (tool name templates, path overrides, …). */
  options?: Record<string, unknown>;
  /** Federated read cache TTL (seconds). 0/undefined disables caching. */
  cache_ttl_seconds?: number;
}

export interface DataSourceConfig {
  mode: EntityMode;
  connector?: ConnectorConfig;
}

/** Per-entity-type wiring registered by the owning module (e.g. B2B). */
export interface EntityTypeSpec<T> {
  type: string;
  native: NativeStore<T>;
  /** Map a connector's raw record into the typed entity (tenant injected). */
  mapper: (raw: RawRecord, tenant: string) => T;
}
