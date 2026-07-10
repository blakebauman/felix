/**
 * Pricing-rule store (D1). Tolerant of malformed rows — a bad `config_json`
 * resolves to an empty config rather than failing price resolution.
 */

import type { Env } from '../../env';
import { PricingRule, PricingRuleConfig } from './models';

interface Row {
  tenant_id: string;
  id: string;
  scope: string;
  target: string;
  kind: string;
  adjustment_bps: number;
  config_json: string;
  active: number;
  created_at: number;
}

function safeConfig(s: string): PricingRuleConfig {
  try {
    return PricingRuleConfig.parse(JSON.parse(s));
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
      active: row.active === 1,
      created_at: row.created_at,
    });
  } catch {
    return null;
  }
}

/** Active rules for a tenant. Small per-tenant set; loaded per price resolution. */
export async function listActiveRules(env: Env, tenant: string): Promise<PricingRule[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM pricing_rules WHERE tenant_id = ? AND active = 1 ORDER BY created_at',
  )
    .bind(tenant)
    .all<Row>();
  return (rows.results ?? []).map(rowToRule).filter((r): r is PricingRule => r !== null);
}

export async function upsertPricingRule(env: Env, rule: PricingRule): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pricing_rules
       (tenant_id, id, scope, target, kind, adjustment_bps, config_json, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       scope = excluded.scope,
       target = excluded.target,
       kind = excluded.kind,
       adjustment_bps = excluded.adjustment_bps,
       config_json = excluded.config_json,
       active = excluded.active`,
  )
    .bind(
      rule.tenant_id,
      rule.id,
      rule.scope,
      rule.target,
      rule.kind,
      rule.adjustment_bps,
      JSON.stringify(rule.config),
      rule.active ? 1 : 0,
      rule.created_at,
    )
    .run();
}
