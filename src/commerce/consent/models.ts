/**
 * Consent + attribution models (Zod). `Consent` mirrors the `consents` table
 * (append-only); `OrderAttribution` mirrors `order_attribution` (1:1 with orders).
 */

import { z } from '@hono/zod-openapi';

export const ConsentChannel = z.enum(['chat', 'acp', 'b2b', 'widget']);
export type ConsentChannel = z.infer<typeof ConsentChannel>;

export const Consent = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: z.string().min(1),
    subject: z.string().default(''),
    thread_id: z.string().default(''),
    channel: ConsentChannel.default('chat'),
    scopes: z.array(z.string()).default(['terms']),
    granted: z.boolean().default(false),
    terms_version: z.string().default(''),
    policy_url: z.string().default(''),
    created_at: z.number().int(),
  })
  .strict()
  .openapi('Consent');
export type Consent = z.infer<typeof Consent>;

export const OrderAttribution = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    order_id: z.string().min(1),
    channel: z.string().default(''),
    manifest_id: z.string().default(''),
    thread_id: z.string().default(''),
    buyer_subject: z.string().default(''),
    consent_id: z.string().default(''),
    utm: z.record(z.string(), z.string()).default({}),
    created_at: z.number().int(),
  })
  .strict()
  .openapi('OrderAttribution');
export type OrderAttribution = z.infer<typeof OrderAttribution>;

/** Tool/endpoint input to capture consent. */
export const RecordConsentRequest = z
  .object({
    granted: z.boolean(),
    scopes: z.array(z.string()).optional(),
    channel: ConsentChannel.optional(),
    terms_version: z.string().optional(),
    policy_url: z.string().optional(),
  })
  .strict()
  .openapi('RecordConsentRequest');
export type RecordConsentRequest = z.infer<typeof RecordConsentRequest>;
