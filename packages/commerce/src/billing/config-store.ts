/**
 * `billing_settings` (Postgres) — the chosen billing provider per tenant.
 * Absent row → the env default (`BILLING_PROVIDER_DEFAULT`) or `internal`.
 */

import { getDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';

export interface BillingSettings {
  provider: string;
  config: Record<string, unknown>;
}

export async function getBillingSettings(env: Env, tenant: string): Promise<BillingSettings> {
  const sql = getDb(env);
  const rows = await sql<{ provider: string; config_json: Record<string, unknown> | null }[]>`
    SELECT provider, config_json FROM billing_settings WHERE tenant_id = ${tenant} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { provider: env.BILLING_PROVIDER_DEFAULT || 'internal', config: {} };
  return { provider: row.provider || 'internal', config: row.config_json ?? {} };
}

export async function setBillingSettings(
  env: Env,
  tenant: string,
  settings: BillingSettings,
  updatedBy: string,
): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO billing_settings (tenant_id, provider, config_json, updated_at, updated_by)
      VALUES (${tenant}, ${settings.provider}, ${settings.config as Record<string, unknown>},
              ${Date.now()}, ${updatedBy})
      ON CONFLICT (tenant_id) DO UPDATE SET
        provider = excluded.provider, config_json = excluded.config_json,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `;
}
