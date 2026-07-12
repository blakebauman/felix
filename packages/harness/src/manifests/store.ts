/**
 * Postgres store for tenant-managed manifests.
 *
 * Storage shape:
 *   - `manifests`        — append-only version log, PK (tenant_id, name, version)
 *   - `manifest_active`  — pointer to the active version, PK (tenant_id, name)
 *
 * The version column is a per-(tenant_id, name) monotonic integer that we
 * allocate by reading the current MAX(version) and inserting MAX+1 in the
 * same transaction that flips the active pointer. Concurrent creates on the
 * same (tenant, name) can collide on the PRIMARY KEY and surface as a 5xx —
 * callers may retry.
 */

import { getDb } from '../db/client';
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
  const sql = getDb(env);
  const rows = await sql<{ v: number | null }[]>`
    SELECT MAX(version) AS v FROM manifests WHERE tenant_id = ${tenantId} AND name = ${name}
  `;
  return (rows[0]?.v ?? 0) + 1;
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
  const comment = input.comment ?? '';
  const sql = getDb(env);

  // Version insert + active-pointer flip are one transaction so a reader
  // never sees a pointer to a version that isn't durably written.
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO manifests
        (tenant_id, name, version, manifest_json, created_at, created_by, comment)
        VALUES (${input.tenantId}, ${input.name}, ${version},
                ${input.manifest as unknown as Record<string, unknown>}, ${now},
                ${input.createdBy}, ${comment})
    `;
    if (input.activate ?? true) {
      await tx`
        INSERT INTO manifest_active (tenant_id, name, version, updated_at, updated_by)
          VALUES (${input.tenantId}, ${input.name}, ${version}, ${now}, ${input.createdBy})
          ON CONFLICT (tenant_id, name) DO UPDATE SET
            version = excluded.version,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
      `;
    }
  });
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
  const sql = getDb(env);
  await sql`
    INSERT INTO manifest_active (tenant_id, name, version, updated_at, updated_by)
      VALUES (${input.tenantId}, ${input.name}, ${input.version}, ${now}, ${input.updatedBy})
      ON CONFLICT (tenant_id, name) DO UPDATE SET
        version = excluded.version,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
  `;
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
  const sql = getDb(env);
  const rows = await sql<
    {
      version: number;
      canary_version: number | null;
      canary_weight: number;
      updated_at: number;
      updated_by: string;
    }[]
  >`
    SELECT version, canary_version, canary_weight, updated_at, updated_by
      FROM manifest_active WHERE tenant_id = ${tenantId} AND name = ${name} LIMIT 1
  `;
  const row = rows[0];
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
  const sql = getDb(env);
  await sql`
    UPDATE manifest_active
      SET canary_version = ${input.canaryVersion}, canary_weight = ${weight},
          updated_at = ${now}, updated_by = ${input.updatedBy}
      WHERE tenant_id = ${input.tenantId} AND name = ${input.name}
  `;
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
  const sql = getDb(env);
  if (input.clearVersion) {
    await sql`
      UPDATE manifest_active
        SET canary_version = NULL, canary_weight = 0,
            updated_at = ${now}, updated_by = ${input.updatedBy}
        WHERE tenant_id = ${input.tenantId} AND name = ${input.name}
    `;
    return {
      ...stable,
      canary_version: null,
      canary_weight: 0,
      updated_at: now,
      updated_by: input.updatedBy,
    };
  }
  await sql`
    UPDATE manifest_active
      SET canary_weight = 0, updated_at = ${now}, updated_by = ${input.updatedBy}
      WHERE tenant_id = ${input.tenantId} AND name = ${input.name}
  `;
  return { ...stable, canary_weight: 0, updated_at: now, updated_by: input.updatedBy };
}

export async function getVersion(
  env: Env,
  tenantId: string,
  name: string,
  version: number,
): Promise<ManifestVersionRow | null> {
  const sql = getDb(env);
  const rows = await sql<
    {
      manifest_json: unknown;
      created_at: number;
      created_by: string;
      comment: string;
    }[]
  >`
    SELECT manifest_json, created_at, created_by, comment
      FROM manifests
      WHERE tenant_id = ${tenantId} AND name = ${name} AND version = ${version}
      LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    tenant_id: tenantId,
    name,
    version,
    manifest: ManifestSchema.parse(row.manifest_json),
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
  const sql = getDb(env);
  const rows = await sql<
    { version: number; created_at: number; created_by: string; comment: string }[]
  >`
    SELECT version, created_at, created_by, comment
      FROM manifests
      WHERE tenant_id = ${tenantId} AND name = ${name}
      ORDER BY version DESC
      LIMIT ${Math.min(limit, 500)}
  `;
  return rows.map((r) => ({
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
  const sql = getDb(env);
  const rows = await sql<
    {
      name: string;
      version: number;
      canary_version: number | null;
      canary_weight: number;
      updated_at: number;
    }[]
  >`
    SELECT name, version, canary_version, canary_weight, updated_at FROM manifest_active
      WHERE tenant_id = ${tenantId}
      ORDER BY updated_at DESC
      LIMIT ${Math.min(limit, 500)}
  `;
  return rows.map((r) => ({
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
  const sql = getDb(env);
  const rows = await sql<
    {
      tenant_id: string;
      name: string;
      version: number;
      canary_version: number;
      canary_weight: number;
    }[]
  >`
    SELECT tenant_id, name, version, canary_version, canary_weight
      FROM manifest_active
      WHERE canary_version IS NOT NULL AND canary_weight > 0 AND tenant_id != 'default'
      ORDER BY updated_at DESC
      LIMIT ${Math.min(limit, 1000)}
  `;
  return rows.map((r) => ({
    tenant_id: r.tenant_id,
    name: r.name,
    version: r.version,
    canary_version: r.canary_version,
    canary_weight: r.canary_weight,
  }));
}

export async function deleteName(env: Env, tenantId: string, name: string): Promise<boolean> {
  const sql = getDb(env);
  // Only report success if there was something to delete.
  const existing = await sql<{ hit: number }[]>`
    SELECT 1 AS hit FROM manifest_active WHERE tenant_id = ${tenantId} AND name = ${name} LIMIT 1
  `;
  const anyVersion = await sql<{ hit: number }[]>`
    SELECT 1 AS hit FROM manifests WHERE tenant_id = ${tenantId} AND name = ${name} LIMIT 1
  `;
  if (!existing[0] && !anyVersion[0]) return false;
  // Pointer + version log removed atomically so a resolver never sees an
  // active pointer to a purged name.
  await sql.begin(async (tx) => {
    await tx`DELETE FROM manifest_active WHERE tenant_id = ${tenantId} AND name = ${name}`;
    await tx`DELETE FROM manifests WHERE tenant_id = ${tenantId} AND name = ${name}`;
  });
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
  const sql = getDb(env);
  const result = await sql`
    DELETE FROM manifests
      WHERE tenant_id = ${tenantId} AND name = ${name} AND version = ${version}
  `;
  if (result.count === 0) return { status: 'not_found' };
  return { status: 'deleted' };
}
