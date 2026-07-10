import { z } from '@hono/zod-openapi';

export const PlanStepStatus = z
  .enum(['pending', 'in_progress', 'completed', 'skipped', 'failed'])
  .openapi('PlanStepStatus');
export type PlanStepStatus = z.infer<typeof PlanStepStatus>;

export const PlanStepSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    status: PlanStepStatus.default('pending'),
    result: z.string().default(''),
  })
  .strict()
  .openapi('PlanStep');
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z
  .object({
    id: z.string().openapi({ readOnly: true, description: 'Server-generated plan id.' }),
    tenant_id: z
      .string()
      .openapi({ readOnly: true, description: 'Owning tenant — always the caller’s tenant.' }),
    manifest_id: z.string().default(''),
    title: z.string().default(''),
    steps: z.array(PlanStepSchema).default([]),
    created_at: z
      .number()
      .int()
      .openapi({ readOnly: true, description: 'Server timestamp (ms since epoch).' }),
    updated_at: z
      .number()
      .int()
      .openapi({ readOnly: true, description: 'Server timestamp of the last step update.' }),
  })
  .strict()
  .openapi('Plan');
export type Plan = z.infer<typeof PlanSchema>;
