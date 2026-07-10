/**
 * D1 store for tenant-managed manifests.
 *
 * Storage shape:
 *   - `manifests`        — append-only version log, PK (tenant_id, name, version)
 *   - `manifest_active`  — pointer to the active version, PK (tenant_id, name)
 *
 * The version column is a per-(tenant_id, name) monotonic integer that we
 * allocate by reading the current MAX(version) and inserting MAX+1 in the
 * same `DB.batch()` that flips the active pointer. SQLite serialises batch
 * execution on a single replica so the two statements are atomic relative
 * to other batches; cross-batch races on the same (tenant, name) can
 * collide on the PRIMARY KEY and surface as a 5xx — callers may retry.
 */

import type { Env } from '../env';
import { type Manifest, ManifestSchema } from './schema';

export interface ManifestVersionRow {
  tenant_id: string;
  name: string;
  version: number;
  manifest: Manifest;
  created_at: number;
  created_by: string;
  comment: string;
}

export interface ActiveRow {
  tenant_id: string;
  name: string;
  /** Stable version — what most traffic sees. */
  version: number;
  /**
   * Optional canary version. When set with `canary_weight > 0`, the
   * resolver routes a deterministic subset of threads to this version
   * instead of `version`. Hash key is
   * `(tenant_id, thread_id, name, version, canary_version)` so a
   * canary flip re-randomises bucket assignment.
   */
  canary_version: number | null;
  /** 0–100 percent of traffic routed to `canary_version`. 0 disables. */
  canary_weight: number;
  updated_at: number;
  updated_by: string;
}

interface ActiveSummary {
  name: string;
  active_version: number;
  canary_version: number | null;
  canary_weight: number;
  updated_at: number;
}

export async function nextVersionFor(env: Env, tenantId: string, name: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT MAX(version) AS v FROM manifests WHERE tenant_id = ? AND name = ?',
  )
    .bind(tenantId, name)
    .first<{ v: number | null }>();
  return (row?.v ?? 0) + 1;
}

export async function createVersion(
  env: Env,
  input: {
    tenantId: string;
    name: string;
    manifest: Manifest;
    createdBy: string;
    comment?: string;
    activate?: boolean;
  },
): Promise<ManifestVersionRow> {
  const version = await nextVersionFor(env, input.tenantId, input.name);
  const now = Date.now();
  const json = JSON.stringify(input.manifest);
  const comment = input.comment ?? '';

  const stmts = [
    env.DB.prepare(
      `INSERT INTO manifests
         (tenant_id, name, version, manifest_json, created_at, created_by, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(input.tenantId, input.name, version, json, now, input.createdBy, comment),
  ];

  if (input.activate ?? true) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO manifest_active (tenant_id, name, version, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, name) DO UPDATE SET
           version = excluded.version,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      ).bind(input.tenantId, input.name, version, now, input.createdBy),
    );
  }

  await env.DB.batch(stmts);
  return {
    tenant_id: input.tenantId,
    name: input.name,
    version,
    manifest: input.manifest,
    created_at: now,
    created_by: input.createdBy,
    comment,
  };
}

export async function activateVersion(
  env: Env,
  input: { tenantId: string; name: string; version: number; updatedBy: string },
): Promise<ActiveRow | null> {
  const exists = await getVersion(env, input.tenantId, input.name, input.version);
  if (!exists) return null;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO manifest_active (tenant_id, name, version, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, name) DO UPDATE SET
       version = excluded.version,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  )
    .bind(input.tenantId, input.name, input.version, now, input.updatedBy)
    .run();
  return {
    tenant_id: input.tenantId,
    name: input.name,
    version: input.version,
    canary_version: null,
    canary_weight: 0,
    updated_at: now,
    updated_by: input.updatedBy,
  };
}

export async function getActive(
  env: Env,
  tenantId: string,
  name: string,
): Promise<ActiveRow | null> {
  const row = await env.DB.prepare(
    `SELECT version, canary_version, canary_weight, updated_at, updated_by
       FROM manifest_active WHERE tenant_id = ? AND name = ? LIMIT 1`,
  )
    .bind(tenantId, name)
    .first<{
      version: number;
      canary_version: number | null;
      canary_weight: number;
      updated_at: number;
      updated_by: string;
    }>();
  if (!row) return null;
  return {
    tenant_id: tenantId,
    name,
    version: row.version,
    canary_version: row.canary_version,
    canary_weight: row.canary_weight,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

/**
 * Set the canary pointer for a manifest. `canaryVersion` must already
 * exist in the `manifests` table; `canaryWeight` is clamped to 0..100.
 * A weight of 0 effectively disables the canary even when a version
 * is set — useful for keeping the candidate registered while traffic
 * is paused.
 *
 * Returns the new `ActiveRow` or `null` when there is no stable active
 * row to attach a canary to (a tenant must `POST /manifests/:name`
 * before declaring a canary).
 */
export async function setCanary(
  env: Env,
  input: {
    tenantId: string;
    name: string;
    canaryVersion: number | null;
    canaryWeight: number;
    updatedBy: string;
  },
): Promise<ActiveRow | null> {
  const stable = await getActive(env, input.tenantId, input.name);
  if (!stable) return null;
  if (input.canaryVersion !== null) {
    const exists = await getVersion(env, input.tenantId, input.name, input.canaryVersion);
    if (!exists) {
      throw new Error(
        `canary version ${input.canaryVersion} does not exist for manifest '${input.name}'`,
      );
    }
  }
  const weight = Math.max(0, Math.min(100, Math.floor(input.canaryWeight)));
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE manifest_active
        SET canary_version = ?, canary_weight = ?, updated_at = ?, updated_by = ?
        WHERE tenant_id = ? AND name = ?`,
  )
    .bind(input.canaryVersion, weight, now, input.updatedBy, input.tenantId, input.name)
    .run();
  return {
    ...stable,
    canary_version: input.canaryVersion,
    canary_weight: weight,
    updated_at: now,
    updated_by: input.updatedBy,
  };
}

/**
 * Atomic rollback: zero the canary weight (and optionally clear the
 * canary_version pointer too). Called by the anomaly auto-rollback hook
 * and by the explicit `POST /manifests/:name/rollback` route.
 */
export async function clearCanary(
  env: Env,
  input: { tenantId: string; name: string; clearVersion?: boolean; updatedBy: string },
): Promise<ActiveRow | null> {
  const stable = await getActive(env, input.tenantId, input.name);
  if (!stable) return null;
  const now = Date.now();
  if (input.clearVersion) {
    await env.DB.prepare(
      `UPDATE manifest_active
          SET canary_version = NULL, canary_weight = 0, updated_at = ?, updated_by = ?
          WHERE tenant_id = ? AND name = ?`,
    )
      .bind(now, input.updatedBy, input.tenantId, input.name)
      .run();
    return {
      ...stable,
      canary_version: null,
      canary_weight: 0,
      updated_at: now,
      updated_by: input.updatedBy,
    };
  }
  await env.DB.prepare(
    `UPDATE manifest_active
        SET canary_weight = 0, updated_at = ?, updated_by = ?
        WHERE tenant_id = ? AND name = ?`,
  )
    .bind(now, input.updatedBy, input.tenantId, input.name)
    .run();
  return { ...stable, canary_weight: 0, updated_at: now, updated_by: input.updatedBy };
}

export async function getVersion(
  env: Env,
  tenantId: string,
  name: string,
  version: number,
): Promise<ManifestVersionRow | null> {
  const row = await env.DB.prepare(
    `SELECT manifest_json, created_at, created_by, comment
       FROM manifests
       WHERE tenant_id = ? AND name = ? AND version = ?
       LIMIT 1`,
  )
    .bind(tenantId, name, version)
    .first<{
      manifest_json: string;
      created_at: number;
      created_by: string;
      comment: string;
    }>();
  if (!row) return null;
  return {
    tenant_id: tenantId,
    name,
    version,
    manifest: ManifestSchema.parse(JSON.parse(row.manifest_json)),
    created_at: row.created_at,
    created_by: row.created_by,
    comment: row.comment,
  };
}

export async function listVersions(
  env: Env,
  tenantId: string,
  name: string,
  limit = 100,
): Promise<Array<Omit<ManifestVersionRow, 'manifest'>>> {
  const rows = await env.DB.prepare(
    `SELECT version, created_at, created_by, comment
       FROM manifests
       WHERE tenant_id = ? AND name = ?
       ORDER BY version DESC
       LIMIT ?`,
  )
    .bind(tenantId, name, Math.min(limit, 500))
    .all<{ version: number; created_at: number; created_by: string; comment: string }>();
  return (rows.results ?? []).map((r) => ({
    tenant_id: tenantId,
    name,
    version: r.version,
    created_at: r.created_at,
    created_by: r.created_by,
    comment: r.comment,
  }));
}

export async function listActive(
  env: Env,
  tenantId: string,
  limit = 100,
): Promise<ActiveSummary[]> {
  const rows = await env.DB.prepare(
    `SELECT name, version, canary_version, canary_weight, updated_at FROM manifest_active
       WHERE tenant_id = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
  )
    .bind(tenantId, Math.min(limit, 500))
    .all<{
      name: string;
      version: number;
      canary_version: number | null;
      canary_weight: number;
      updated_at: number;
    }>();
  return (rows.results ?? []).map((r) => ({
    name: r.name,
    active_version: r.version,
    canary_version: r.canary_version,
    canary_weight: r.canary_weight,
    updated_at: r.updated_at,
  }));
}

export interface ActiveCanary {
  tenant_id: string;
  name: string;
  /** Stable version most traffic sees. */
  version: number;
  /** Canary version in flight (always non-null in this result set). */
  canary_version: number;
  canary_weight: number;
}

/**
 * Every manifest across all tenants that currently has a canary in
 * flight (`canary_version` set and `canary_weight > 0`). Cron-scoped:
 * the continuous-eval job (jobs/continuous-eval.ts) walks this to decide
 * which candidates to online-benchmark, mirroring the anomaly detector's
 * cross-tenant scan. The `default` tenant is excluded — anonymous traffic
 * has no managed canaries, and skipping it also breaks the replay loop
 * (continuous-eval replays run under the anonymous cron context).
 */
export async function listActiveCanaries(env: Env, limit = 500): Promise<ActiveCanary[]> {
  const rows = await env.DB.prepare(
    `SELECT tenant_id, name, version, canary_version, canary_weight
       FROM manifest_active
       WHERE canary_version IS NOT NULL AND canary_weight > 0 AND tenant_id != 'default'
       ORDER BY updated_at DESC
       LIMIT ?`,
  )
    .bind(Math.min(limit, 1000))
    .all<{
      tenant_id: string;
      name: string;
      version: number;
      canary_version: number;
      canary_weight: number;
    }>();
  return (rows.results ?? []).map((r) => ({
    tenant_id: r.tenant_id,
    name: r.name,
    version: r.version,
    canary_version: r.canary_version,
    canary_weight: r.canary_weight,
  }));
}

export async function deleteName(env: Env, tenantId: string, name: string): Promise<boolean> {
  // Only report success if there was something to delete.
  const existing = await env.DB.prepare(
    'SELECT 1 AS hit FROM manifest_active WHERE tenant_id = ? AND name = ? LIMIT 1',
  )
    .bind(tenantId, name)
    .first<{ hit: number }>();
  const anyVersion = await env.DB.prepare(
    'SELECT 1 AS hit FROM manifests WHERE tenant_id = ? AND name = ? LIMIT 1',
  )
    .bind(tenantId, name)
    .first<{ hit: number }>();
  if (!existing && !anyVersion) return false;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM manifest_active WHERE tenant_id = ? AND name = ?').bind(
      tenantId,
      name,
    ),
    env.DB.prepare('DELETE FROM manifests WHERE tenant_id = ? AND name = ?').bind(tenantId, name),
  ]);
  return true;
}

export async function deleteVersion(
  env: Env,
  tenantId: string,
  name: string,
  version: number,
): Promise<{ status: 'deleted' } | { status: 'not_found' } | { status: 'active' }> {
  const active = await getActive(env, tenantId, name);
  if (active?.version === version) return { status: 'active' };
  const result = await env.DB.prepare(
    'DELETE FROM manifests WHERE tenant_id = ? AND name = ? AND version = ?',
  )
    .bind(tenantId, name, version)
    .run();
  const meta = result.meta as { changes?: number } | undefined;
  if (!meta?.changes) return { status: 'not_found' };
  return { status: 'deleted' };
}
