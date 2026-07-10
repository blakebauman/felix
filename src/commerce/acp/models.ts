/**
 * Agentic Commerce Protocol (ACP) checkout object models.
 *
 * Field names follow the ACP Agentic Checkout Spec verbatim. All monetary
 * amounts are integer minor units (cents) — `base_amount`, `subtotal`, `tax`,
 * `total`, and every `totals[].amount`.
 *
 * Inbound request schemas are intentionally lenient (no `.strict()`): the
 * calling agent may send forward-compatible fields we don't model yet, and
 * rejecting them would break interop. Response objects are ours to shape.
 */

import { z } from '@hono/zod-openapi';

export const AcpStatus = z.enum([
  'not_ready_for_payment',
  'ready_for_payment',
  'completed',
  'canceled',
]);
export type AcpStatus = z.infer<typeof AcpStatus>;

export const TotalType = z.enum([
  'items_base_amount',
  'items_discount',
  'subtotal',
  'discount',
  'fulfillment',
  'tax',
  'fee',
  'total',
]);
export type TotalType = z.infer<typeof TotalType>;

export const AcpBuyer = z.object({
  name: z.string(),
  email: z.string(),
  phone_number: z.string().optional(),
});
export type AcpBuyer = z.infer<typeof AcpBuyer>;

export const AcpAddress = z.object({
  name: z.string(),
  line_one: z.string(),
  line_two: z.string().optional(),
  city: z.string(),
  state: z.string(),
  country: z.string(),
  postal_code: z.string(),
  phone_number: z.string().optional(),
});
export type AcpAddress = z.infer<typeof AcpAddress>;

export const AcpItem = z.object({
  id: z.string(),
  quantity: z.number().int().positive(),
});
export type AcpItem = z.infer<typeof AcpItem>;

export const AcpPaymentData = z.object({
  token: z.string(),
  provider: z.enum(['stripe', 'adyen', 'braintree']).default('stripe'),
  billing_address: AcpAddress.optional(),
});
export type AcpPaymentData = z.infer<typeof AcpPaymentData>;

// ---- Response sub-objects ----

export interface AcpLineItem {
  id: string;
  item: AcpItem;
  base_amount: number;
  discount: number;
  subtotal: number;
  tax: number;
  total: number;
}

export interface AcpTotal {
  type: TotalType;
  display_text: string;
  amount: number;
}

export interface AcpFulfillmentOption {
  type: 'shipping' | 'digital';
  id: string;
  title: string;
  subtitle?: string;
  carrier?: string;
  earliest_delivery_time?: string;
  latest_delivery_time?: string;
  subtotal: number;
  tax: number;
  total: number;
}

export interface AcpMessage {
  type: 'info' | 'error';
  code?:
    | 'missing'
    | 'invalid'
    | 'out_of_stock'
    | 'payment_declined'
    | 'requires_sign_in'
    | 'requires_3ds';
  param?: string;
  content_type: 'plain' | 'markdown';
  content: string;
}

export interface AcpLink {
  type: 'terms_of_use' | 'privacy_policy' | 'seller_shop_policies';
  url: string;
}

export interface AcpOrder {
  id: string;
  checkout_session_id: string;
  permalink_url: string;
}

export interface AcpCheckoutSession {
  id: string;
  buyer?: AcpBuyer;
  payment_provider?: { provider: 'stripe'; supported_payment_methods: string[] };
  status: AcpStatus;
  currency: string;
  line_items: AcpLineItem[];
  fulfillment_address?: AcpAddress;
  fulfillment_options: AcpFulfillmentOption[];
  fulfillment_option_id?: string;
  totals: AcpTotal[];
  messages: AcpMessage[];
  links: AcpLink[];
  order?: AcpOrder;
}

// ---- Inbound request bodies (lenient) ----

export const CreateSessionRequest = z.object({
  items: z.array(AcpItem).min(1),
  buyer: AcpBuyer.optional(),
  fulfillment_address: AcpAddress.optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const UpdateSessionRequest = z.object({
  items: z.array(AcpItem).optional(),
  buyer: AcpBuyer.optional(),
  fulfillment_address: AcpAddress.optional(),
  fulfillment_option_id: z.string().optional(),
});
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

export const CompleteSessionRequest = z.object({
  buyer: AcpBuyer.optional(),
  payment_data: AcpPaymentData,
});
export type CompleteSessionRequest = z.infer<typeof CompleteSessionRequest>;
