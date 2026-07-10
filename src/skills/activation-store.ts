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

import type { Env } from '../env';

export async function getActivated(
  env: Env,
  tenantId: string,
  manifestId: string,
): Promise<string[] | null> {
  if (!tenantId) return null;
  const row = await env.DB.prepare(
    'SELECT active_skills FROM skill_activation WHERE tenant_id = ? AND manifest_id = ? LIMIT 1',
  )
    .bind(tenantId, manifestId)
    .first<{ active_skills: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.active_skills);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : null;
  } catch {
    return null;
  }
}

export async function setActivated(
  env: Env,
  tenantId: string,
  manifestId: string,
  skills: string[],
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO skill_activation (tenant_id, manifest_id, active_skills, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (tenant_id, manifest_id) DO UPDATE SET active_skills = excluded.active_skills, updated_at = excluded.updated_at`,
  )
    .bind(tenantId, manifestId, JSON.stringify(skills), now)
    .run();
}
