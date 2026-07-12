import { z } from '@hono/zod-openapi';

/**
 * Audit event types. Adding a new type is a forward-compatible change —
 * readers tolerate unknowns.
 */
/**
 * `tool_call` is emitted by the react/deep loop around each tool dispatch
 * and carries `transport` in its payload (local / mcp / a2a / container /
 * queue). For `queue`-transport dispatches the `tool_call` row only
 * records the *enqueue* — the resolving `tool_result` arrives later, via
 * a consumer-side `queue_complete` event paired by `job_id`. Cycles that
 * never resolve trip the orphan-cleanup path and emit `queue_expired`.
 *
 * `tool_call` for a peer (A2A) invocation is the same event with
 * `transport: 'a2a'` — there is no separate `peer_dispatch` event.
 * `audit_truncated` is NOT a separate event type; it's a `status` value
 * applied to whatever event triggered the per-request audit cap, with
 * payload `{ reason: 'per_request_cap', cap: N }`.
 */
export const AuditEventType = z
  .enum([
    'tool_call',
    'policy_decision',
    'limit_exceeded',
    'guardrail_block',
    'plan_step',
    'job_run',
    'approval_request',
    'approval_decision',
    'approval_consumed',
    'approval_expired',
    'checkpoint_failure',
    'queue_dispatch',
    'queue_complete',
    'queue_expired',
    'manifest_created',
    'manifest_activated',
    'manifest_deleted',
    'unhandled_error',
    'judge_score',
    'eval_run',
    'anomaly_detected',
    'manifest_canary_set',
    'manifest_canary_cleared',
    'auto_rollback',
    'model_switch',
    'retention_sweep',
    'commerce_order',
    'brand_provisioned',
    'brand_catalog_import',
    'b2b_purchase_check',
    'b2b_quote',
    'geo_observation',
    'consent_recorded',
    'order_attributed',
    'cart_abandoned',
  ])
  .openapi('AuditEventType');
export type AuditEventType = z.infer<typeof AuditEventType>;

export const AuditEventSchema = z
  .object({
    id: z.string().openapi({ readOnly: true, description: 'Server-generated event id.' }),
    tenant_id: z
      .string()
      .openapi({ readOnly: true, description: 'Owning tenant — always the caller’s tenant.' }),
    ts: z
      .number()
      .int()
      .openapi({ readOnly: true, description: 'Server timestamp (ms since epoch).' }),
    event_type: AuditEventType,
    manifest_id: z.string().default(''),
    principal_subject: z
      .string()
      .default('')
      .openapi({ readOnly: true, description: 'Subject from the verified JWT, if any.' }),
    status: z.string().default(''),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .openapi('AuditEvent');

export type AuditEvent = z.infer<typeof AuditEventSchema>;
