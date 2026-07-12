/**
 * Per-tenant skill activation overlay.
 *
 * Semantics (strict):
 *   - `null`        — no overlay record → use the manifest's full skill set.
 *   - `[]`          — empty overlay → *all* manifest skills disabled.
 *   - `[a, b, …]`   — overlay → intersect with manifest skills.
 *
 * The overlay can only ever *restrict* the manifest — it never adds skills
 * the manifest didn't declare. Enforced at the call site in builder.ts.
 */

import { getDb } from '../db/client';
import type { Env } from '../env';

export async function getActivated(
  env: Env,
  tenantId: string,
  manifestId: string,
): Promise<string[] | null> {
  if (!tenantId) return null;
  const sql = getDb(env);
  const rows = await sql<{ active_skills: unknown }[]>`
    SELECT active_skills FROM skill_activation
      WHERE tenant_id = ${tenantId} AND manifest_id = ${manifestId} LIMIT 1
  `;
  if (!rows[0]) return null;
  const parsed = rows[0].active_skills;
  return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : null;
}

export async function setActivated(
  env: Env,
  tenantId: string,
  manifestId: string,
  skills: string[],
): Promise<void> {
  const now = Date.now();
  const sql = getDb(env);
  await sql`
    INSERT INTO skill_activation (tenant_id, manifest_id, active_skills, updated_at)
      VALUES (${tenantId}, ${manifestId}, ${skills}, ${now})
      ON CONFLICT (tenant_id, manifest_id) DO UPDATE SET
        active_skills = excluded.active_skills, updated_at = excluded.updated_at
  `;
}
