/**
 * Plan persistence in D1.
 * Composite key (tenant_id, plan_id) preserves tenant isolation.
 */

import type { Env } from '../env';
import { type Plan, PlanSchema, type PlanStepStatus } from './models';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface CreatePlanInput {
  tenantId: string;
  manifestId: string;
  title: string;
  steps: string[];
}

export async function createPlan(env: Env, input: CreatePlanInput): Promise<Plan> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const plan = PlanSchema.parse({
    id,
    tenant_id: input.tenantId,
    manifest_id: input.manifestId,
    title: input.title,
    steps: input.steps.map((desc, i) => ({
      id: `s${i + 1}`,
      description: desc,
      status: 'pending',
      result: '',
    })),
    created_at: now,
    updated_at: now,
  });
  await env.DB.prepare(
    `INSERT INTO plans (id, tenant_id, manifest_id, created_at, updated_at, expires_at, plan_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      plan.id,
      plan.tenant_id,
      plan.manifest_id,
      plan.created_at,
      plan.updated_at,
      now + DEFAULT_TTL_MS,
      JSON.stringify(plan),
    )
    .run();
  return plan;
}

export async function getPlan(env: Env, tenantId: string, id: string): Promise<Plan | null> {
  const row = await env.DB.prepare(
    'SELECT plan_json FROM plans WHERE tenant_id = ? AND id = ? LIMIT 1',
  )
    .bind(tenantId, id)
    .first<{ plan_json: string }>();
  if (!row) return null;
  return PlanSchema.parse(JSON.parse(row.plan_json));
}

export async function listPlans(env: Env, tenantId: string, limit = 100): Promise<Plan[]> {
  const rows = await env.DB.prepare(
    'SELECT plan_json FROM plans WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?',
  )
    .bind(tenantId, Math.min(limit, 500))
    .all<{ plan_json: string }>();
  return (rows.results ?? []).map((r) => PlanSchema.parse(JSON.parse(r.plan_json)));
}

export async function updatePlanStep(
  env: Env,
  tenantId: string,
  planId: string,
  stepId: string,
  update: { status: PlanStepStatus; result?: string },
): Promise<Plan | null> {
  const plan = await getPlan(env, tenantId, planId);
  if (!plan) return null;
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) return null;
  step.status = update.status;
  if (update.result !== undefined) step.result = update.result;
  plan.updated_at = Date.now();
  await env.DB.prepare(
    'UPDATE plans SET plan_json = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
  )
    .bind(JSON.stringify(plan), plan.updated_at, tenantId, planId)
    .run();
  return plan;
}
