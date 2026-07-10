/**
 * Plan tools auto-injected for deep agents.
 *
 * Plans are JSON-serializable (so they survive across runs) and persisted
 * through the D1-backed `plans` store. The deep agent uses these to
 * externalize its todo list — separate from any in-conversation state.
 */

import { z } from 'zod';
import { recordEvent } from '../audit/store';
import { getContext } from '../context';
import { defineTool } from '../tools/types';
import { createPlan, getPlan, updatePlanStep } from './store';

export const planCreate = defineTool({
  name: 'plan_create',
  description: 'Create a new plan with a title and an ordered list of step descriptions.',
  args: z.object({
    title: z.string(),
    steps: z.array(z.string()).min(1),
  }),
  async handler({ title, steps }, invocationCtx) {
    const ctx = getContext();
    if (!ctx) return '[plan_create error] no request context';
    const plan = await createPlan(ctx.env, {
      tenantId: ctx.auth.principal.tenantId,
      // Prefer the manifestId the pattern passed via ToolInvocationCtx —
      // `RequestContext.manifestId` is not set by any production route,
      // so falling back to it produces empty manifest_id audit rows.
      manifestId: invocationCtx?.manifestId ?? ctx.manifestId ?? '',
      title,
      steps,
    });
    return JSON.stringify({ plan_id: plan.id, steps: plan.steps });
  },
});

export const planUpdateStep = defineTool({
  name: 'plan_update_step',
  description: 'Mark a step as in_progress/completed/skipped/failed with an optional result.',
  args: z.object({
    plan_id: z.string(),
    step_id: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed', 'skipped', 'failed']),
    result: z.string().optional().default(''),
  }),
  async handler({ plan_id, step_id, status, result }, invocationCtx) {
    const ctx = getContext();
    if (!ctx) return '[plan_update_step error] no request context';
    const plan = await updatePlanStep(ctx.env, ctx.auth.principal.tenantId, plan_id, step_id, {
      status,
      result,
    });
    if (!plan) return `[plan_update_step error] plan ${plan_id} not found`;
    // Emit one `plan_step` audit row per update so the plan lifecycle is
    // observable without snapshotting the full plan into the payload.
    recordEvent({
      tenantId: ctx.auth.principal.tenantId,
      eventType: 'plan_step',
      principalSubject: ctx.auth.principal.subject,
      // Same reason as plan_create: the pattern's ToolInvocationCtx is
      // the canonical source, RequestContext.manifestId is unset in prod.
      manifestId: invocationCtx?.manifestId ?? ctx.manifestId ?? '',
      status,
      payload: { plan_id, step_id, result_present: (result ?? '').length > 0 },
    });
    return JSON.stringify({ plan_id: plan.id, steps: plan.steps });
  },
});

export const planGet = defineTool({
  name: 'plan_get',
  description: 'Fetch the current state of a plan by id.',
  args: z.object({ plan_id: z.string() }),
  async handler({ plan_id }) {
    const ctx = getContext();
    if (!ctx) return '[plan_get error] no request context';
    const plan = await getPlan(ctx.env, ctx.auth.principal.tenantId, plan_id);
    if (!plan) return `[plan_get error] plan ${plan_id} not found`;
    return JSON.stringify(plan);
  },
});

export const PLAN_TOOLS = [planCreate, planUpdateStep, planGet] as const;
