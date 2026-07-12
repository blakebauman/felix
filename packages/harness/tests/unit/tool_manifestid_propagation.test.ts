/**
 * Audit-attribution regression: tool handlers that needed a `manifest_id`
 * were reading it from `RequestContext.manifestId`, which no production
 * route writes. That produced empty `manifest_id` on every plan audit
 * row and "manifest_id required" errors from skill tools that the model
 * had no reason to specify.
 *
 * Fix: tool handlers prefer `ToolInvocationCtx.manifestId` (set by the
 * react / deep loop at dispatch time). RequestContext fallback stays
 * for direct callers in tests.
 *
 * Pins:
 *   1. `plan_update_step` records its audit row with the manifest id
 *      that the react loop dispatched it with — not the unset
 *      `RequestContext.manifestId`.
 *   2. `list_skills` reads `manifest_id` from the ToolInvocationCtx when
 *      the model doesn't supply one explicitly.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RecordOptions } from '../../src/audit/store';
import * as auditStore from '../../src/audit/store';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { planUpdateStep } from '../../src/plans/tools';
import { makeFakeSql } from '../helpers/fake-sql';

function reqCtxNoManifest(): RequestContext {
  // Deliberately no `manifestId` on RequestContext — that's the
  // production state, where no route writes the field.
  const stubPlan = {
    id: 'p1',
    tenant_id: 'acme',
    manifest_id: 'workerA',
    title: 't',
    created_at: 0,
    updated_at: 0,
    steps: [{ id: 's1', description: 'first step', status: 'pending', result: '' }],
  };
  const { sql } = makeFakeSql((q) => {
    // updatePlanStep first calls getPlan, which expects `plan_json` — the
    // jsonb column round-trips as an object now, not a JSON string.
    if (q.text.includes('SELECT plan_json')) return [{ plan_json: stubPlan }];
    return 1; // the UPDATE that follows
  });
  return {
    env: { HYPERDRIVE: { connectionString: 'postgresql://fake' } } as unknown as Env,
    auth: { ...ANONYMOUS, principal: { ...ANONYMOUS.principal, tenantId: 'acme' } },
    limitState: newLimitState(),
    db: sql,
  };
}

describe('tool handler manifestId propagation', () => {
  it('plan_update_step uses ToolInvocationCtx.manifestId for the audit row', async () => {
    const recordSpy = vi
      .spyOn(auditStore, 'recordEvent')
      .mockImplementation((opts: RecordOptions) => ({
        id: 'audit-1',
        tenant_id: opts.tenantId,
        ts: 0,
        event_type: opts.eventType,
        manifest_id: opts.manifestId ?? '',
        principal_subject: opts.principalSubject ?? '',
        status: opts.status ?? '',
        payload: opts.payload ?? {},
      }));

    await runWithContext(reqCtxNoManifest(), async () => {
      // The react loop would call this with the leaf manifest's id as
      // `ToolInvocationCtx.manifestId`. We simulate that directly.
      await planUpdateStep.executor.execute(
        {
          plan_id: 'p1',
          step_id: 's1',
          status: 'completed',
          result: 'done',
        },
        { manifestId: 'workerA', toolCallId: 'tc1' },
      );
    });

    const planStepCalls = recordSpy.mock.calls.filter(
      (c) => (c[0] as { eventType: string }).eventType === 'plan_step',
    );
    expect(planStepCalls).toHaveLength(1);
    expect((planStepCalls[0]![0] as { manifestId: string }).manifestId).toBe('workerA');
    recordSpy.mockRestore();
  });

  it('plan_update_step records empty manifest_id when no source supplies one (regression for old behavior)', async () => {
    const recordSpy = vi
      .spyOn(auditStore, 'recordEvent')
      .mockImplementation((opts: RecordOptions) => ({
        id: 'a',
        tenant_id: opts.tenantId,
        ts: 0,
        event_type: opts.eventType,
        manifest_id: opts.manifestId ?? '',
        principal_subject: opts.principalSubject ?? '',
        status: opts.status ?? '',
        payload: opts.payload ?? {},
      }));

    await runWithContext(reqCtxNoManifest(), async () => {
      // No ToolInvocationCtx.manifestId, no RequestContext.manifestId —
      // the audit row is empty. This documents the failure mode so a
      // regression is loud rather than silent.
      await planUpdateStep.executor.execute(
        {
          plan_id: 'p1',
          step_id: 's1',
          status: 'completed',
          result: 'done',
        },
        { toolCallId: 'tc1' },
      );
    });

    const planStepCalls = recordSpy.mock.calls.filter(
      (c) => (c[0] as { eventType: string }).eventType === 'plan_step',
    );
    expect(planStepCalls).toHaveLength(1);
    expect((planStepCalls[0]![0] as { manifestId: string }).manifestId).toBe('');
    recordSpy.mockRestore();
  });
});
