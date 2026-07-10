import { z } from '@hono/zod-openapi';

export const PolicySchema = z
  .object({
    id: z.string().min(1).openapi({
      description:
        'Stable policy id. Federation-bundle policies merge with manifest policies and win on id collision.',
      example: 'write-paths',
    }),
    description: z.string().default('').openapi({ description: 'Free-form policy description.' }),
    required_scopes: z
      .array(z.string())
      .default([])
      .openapi({
        description:
          'Scopes AND-checked against `principal.scopes`. A tool listed in multiple ' +
          'policies must satisfy all of them.',
        example: ['data:write'],
      }),
    tools: z
      .array(z.string())
      .default([])
      .openapi({
        description: 'Tool names this policy gates.',
        example: ['update_record'],
      }),
  })
  .strict()
  .openapi('Policy');

export type Policy = z.infer<typeof PolicySchema>;

export const PolicyBundleSchema = z
  .object({
    version: z.string().min(1).openapi({ description: 'Bundle version (free-form).' }),
    issuer: z.string().min(1).openapi({ description: 'Bundle issuer identifier.' }),
    policies: z.array(PolicySchema).default([]).openapi({ description: 'Bundle policies.' }),
    approvals: z.array(z.unknown()).default([]).openapi({
      description: 'Reserved for federation-distributed approval rules.',
    }),
    signature: z
      .string()
      .optional()
      .openapi({
        description:
          'Ed25519 signature (base64). Verified against `POLICY_BUNDLE_PUBKEY` on load. ' +
          'Required in staging/production; optional in dev with a warning.',
      }),
  })
  .strict()
  .openapi('PolicyBundle');

export type PolicyBundle = z.infer<typeof PolicyBundleSchema>;
