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
  })
  .strict()
  .openapi('ApprovalRule');

export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;

export const ApprovalStatus = z.enum(['pending', 'approved', 'denied']).openapi('ApprovalStatus');
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
  })
  .strict()
  .openapi('ApprovalRequest');

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
