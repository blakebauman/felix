/**
 * Predictive-personalization models (Zod).
 *
 * `Customer` mirrors the `customers` table; `BehaviorEvent` mirrors
 * `behavior_events`. Behavior events are an append-only stream of shopping
 * signals that seed recommendations and abandoned-cart detection. Thread id is
 * always present; customer id is optional (anonymous shoppers).
 */

import { z } from '@hono/zod-openapi';

export const CustomerSchema = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: z.string().min(1),
    email: z.string().default(''),
    external_ref: z.string().default(''),
    attrs: z.record(z.string(), z.unknown()).default({}),
    created_at: z.number().int(),
    last_seen_at: z.number().int().default(0),
  })
  .strict()
  .openapi('Customer');
export type Customer = z.infer<typeof CustomerSchema>;

export const BehaviorType = z.enum(['view', 'add_to_cart', 'remove', 'checkout_start', 'purchase']);
export type BehaviorType = z.infer<typeof BehaviorType>;

export const BehaviorEventSchema = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: z.string().min(1),
    customer_id: z.string().default(''),
    thread_id: z.string().default(''),
    type: BehaviorType,
    product_id: z.string().default(''),
    ts: z.number().int(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .openapi('BehaviorEvent');
export type BehaviorEvent = z.infer<typeof BehaviorEventSchema>;
