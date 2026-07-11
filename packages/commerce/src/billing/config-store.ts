/**
 * `billing_settings` (D1) — the chosen billing provider per tenant. Absent row
 * → the env default (`BILLING_PROVIDER_DEFAULT`) or `internal`.
 */

import type { Env } from '@felix/harness/env';

export interface BillingSettings {
  provider: string;
  config: Record<string, unknown>;
}

export async function getBillingSettings(env: Env, tenant: string): Promise<BillingSettings> {
  const row = await env.DB.prepare(
    'SELECT provider, config_json FROM billing_settings WHERE tenant_id = ? LIMIT 1',
  )
    .bind(tenant)
    .first<{ provider: string; config_json: string }>();
  if (!row) return { provider: env.BILLING_PROVIDER_DEFAULT || 'internal', config: {} };
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(row.config_json);
  } catch {
    /* default */
  }
  return { provider: row.provider || 'internal', config };
}

export async function setBillingSettings(
  env: Env,
  tenant: string,
  settings: BillingSettings,
  updatedBy: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO billing_settings (tenant_id, provider, config_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id) DO UPDATE SET
       provider = excluded.provider, config_json = excluded.config_json,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(tenant, settings.provider, JSON.stringify(settings.config), Date.now(), updatedBy)
    .run();
}
