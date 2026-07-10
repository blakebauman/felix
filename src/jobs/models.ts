import { z } from '@hono/zod-openapi';

export const JobRecordSchema = z
  .object({
    tenant_id: z.string().min(1).default('default').openapi({
      readOnly: true,
      description: 'Owning tenant — overwritten server-side from the authenticated principal.',
    }),
    name: z.string().min(1).max(128).openapi({
      description: 'Job name. Unique within a tenant. 1–128 chars.',
      example: 'nightly-digest',
    }),
    schedule: z
      .string()
      .default('')
      .openapi({
        description:
          'Standard 5-field cron expression (`m h dom mon dow`). Empty disables ' +
          'automatic scheduling — the job can still be triggered manually.',
        example: '0 9 * * *',
      }),
    manifest_id: z.string().default('').openapi({
      description: 'Manifest the cron sweep invokes for this job.',
      example: 'quick',
    }),
    last_run_at: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ readOnly: true, description: 'Timestamp of the most recent run (ms).' }),
    next_run_at: z.number().int().nullable().optional().openapi({
      readOnly: true,
      description: 'Computed by the server from `schedule` after each run.',
    }),
    last_status: z
      .string()
      .default('')
      .openapi({ readOnly: true, description: 'Outcome of the most recent run.' }),
    last_error: z
      .string()
      .default('')
      .openapi({ readOnly: true, description: 'Error message from the most recent run, if any.' }),
    created_at: z
      .number()
      .int()
      .openapi({ readOnly: true, description: 'Server timestamp (ms since epoch).' }),
    payload: z.record(z.string(), z.unknown()).default({}).openapi({
      description: 'Free-form payload passed to the manifest on each run.',
    }),
  })
  .strict()
  .openapi('JobRecord');

export type JobRecord = z.infer<typeof JobRecordSchema>;
