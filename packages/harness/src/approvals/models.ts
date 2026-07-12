import { z } from '@hono/zod-openapi';

export const ApprovalRuleSchema = z
  .object({
    id: z.string().min(1).openapi({
      description: 'Stable rule id, persisted on each `approval_request` row.',
      example: 'production-writes',
    }),
    description: z.string().default('').openapi({ description: 'Free-form rule description.' }),
    tools: z
      .array(z.string())
      .default([])
      .openapi({
        description:
          'Tools that require human approval. The wrapper synthesizes a deterministic call ' +
          'signature, persists an `approval_request` row, and returns a deny string to the ' +
          'model. The approver decides through `POST /approvals/{id}/decide`; the next ' +
          'retry with the same arguments goes through.',
        example: ['notion__create_page', 'notion__update_page'],
      }),
    ttl_seconds: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({
        description:
          'Opt-in grant expiry. When set, an approved grant expires this many seconds after ' +
          'it was DECIDED (`expires_at = decided_at + ttl_seconds`). A call that lands after ' +
          'expiry re-requests approval with a fresh id instead of replaying the stale grant. ' +
          'Omit (default) for a non-expiring grant — the pre-existing behavior.',
        example: 3600,
      }),
    one_shot: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'When true, an approved grant is consumed on first execution and cannot be reused — ' +
          'the next call with the same signature re-requests approval. The grant is claimed ' +
          '(transitioned `approved → consumed`) through ApprovalsDO BEFORE the tool runs so ' +
          'two concurrent retries can never both execute. Default false replays the grant.',
      }),
    bind_principal: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'When true, the grant is bound to the requesting principal subject: the subject is ' +
          'mixed into the call signature so a different subject on the same tenant / manifest / ' +
          'tool / args gets a distinct signature and must re-request. Default false keeps the ' +
          'tenant-wide (subject-agnostic) signature, the pre-existing behavior.',
      }),
  })
  .strict()
  .openapi('ApprovalRule');

export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;

// `consumed` (one-shot grant spent) and `expired` (TTL elapsed) are terminal,
// archived states — excluded from the active partial unique index on the call
// signature so a superseded grant no longer authorizes and a fresh request can
// be minted with the same signature. Only `pending` / `approved` / `denied`
// are "live" decisions.
export const ApprovalStatus = z
  .enum(['pending', 'approved', 'denied', 'consumed', 'expired'])
  .openapi('ApprovalStatus');
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalRequestSchema = z
  .object({
    id: z.string().openapi({ readOnly: true, description: 'Server-generated approval id.' }),
    tenant_id: z
      .string()
      .openapi({ readOnly: true, description: 'Owning tenant — always the caller’s tenant.' }),
    manifest_id: z.string().default('').openapi({ readOnly: true }),
    tool_name: z.string().openapi({ readOnly: true }),
    call_signature: z.string().default('').openapi({
      readOnly: true,
      description: 'Deterministic signature of the pending tool call.',
    }),
    args: z.record(z.string(), z.unknown()).default({}).openapi({ readOnly: true }),
    principal_subject: z.string().default('').openapi({
      readOnly: true,
      description: 'Subject from the verified JWT that triggered the request.',
    }),
    status: ApprovalStatus.default('pending'),
    created_at: z
      .number()
      .int()
      .openapi({ readOnly: true, description: 'Server timestamp (ms since epoch).' }),
    decided_at: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ readOnly: true, description: 'Set when the request is decided.' }),
    decided_by: z.string().default('').openapi({
      readOnly: true,
      description: 'Subject of the principal that decided this request.',
    }),
    decision_note: z.string().default(''),
    edited_args: z.record(z.string(), z.unknown()).nullable().optional(),
    expires_at: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({
        readOnly: true,
        description:
          'Grant expiry (ms since epoch), set at decide time when the matching rule declares ' +
          '`ttl_seconds`. Null means the grant never expires.',
      }),
  })
  .strict()
  .openapi('ApprovalRequest');

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
