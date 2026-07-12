/**
 * Pricing-rule store (Postgres). Tolerant of malformed rows — a bad
 * `config_json` resolves to an empty config rather than failing price
 * resolution.
 */

import { getDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';
import { PricingRule, PricingRuleConfig } from './models';

interface Row {
  tenant_id: string;
  id: string;
  scope: string;
  target: string;
  kind: string;
  adjustment_bps: number;
  config_json: unknown;
  active: boolean;
  created_at: number;
}

function safeConfig(v: unknown): PricingRuleConfig {
  try {
    return PricingRuleConfig.parse(v ?? {});
  } catch {
    return {};
  }
}

function rowToRule(row: Row): PricingRule | null {
  try {
    return PricingRule.parse({
      tenant_id: row.tenant_id,
      id: row.id,
      scope: row.scope,
      target: row.target,
      kind: row.kind,
      adjustment_bps: row.adjustment_bps,
      config: safeConfig(row.config_json),
      active: row.active,
      created_at: row.created_at,
    });
  } catch {
    return null;
  }
}

/** Active rules for a tenant. Small per-tenant set; loaded per price resolution. */
export async function listActiveRules(env: Env, tenant: string): Promise<PricingRule[]> {
  const sql = getDb(env);
  const rows = await sql<Row[]>`
    SELECT * FROM pricing_rules WHERE tenant_id = ${tenant} AND active = true
      ORDER BY created_at
  `;
  return rows.map(rowToRule).filter((r): r is PricingRule => r !== null);
}

export async function upsertPricingRule(env: Env, rule: PricingRule): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO pricing_rules
        (tenant_id, id, scope, target, kind, adjustment_bps, config_json, active, created_at)
      VALUES (${rule.tenant_id}, ${rule.id}, ${rule.scope}, ${rule.target}, ${rule.kind},
              ${rule.adjustment_bps}, ${rule.config as Record<string, unknown>},
              ${rule.active}, ${rule.created_at})
      ON CONFLICT (tenant_id, id) DO UPDATE SET
        scope = excluded.scope,
        target = excluded.target,
        kind = excluded.kind,
        adjustment_bps = excluded.adjustment_bps,
        config_json = excluded.config_json,
        active = excluded.active
  `;
}
