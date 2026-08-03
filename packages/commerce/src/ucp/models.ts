/**
 * Universal Commerce Protocol (UCP) checkout object models.
 *
 * Field names follow the UCP shopping/checkout schema (with the fulfillment
 * extension) verbatim — see https://ucp.dev/specification/checkout and the
 * reference merchant server at Universal-Commerce-Protocol/samples. All
 * monetary amounts are integer minor units (cents).
 *
 * Inbound request schemas are intentionally lenient (no `.strict()`): calling
 * platforms send forward-compatible fields we don't model yet, and rejecting
 * them would break interop. Response objects are ours to shape.
 */

import { z } from '@hono/zod-openapi';

/** UCP spec version this endpoint implements (YYYY-MM-DD release tags). */
export const UCP_VERSION = '2026-04-08';

export const UcpStatus = z.enum([
  'incomplete',
  'ready_for_complete',
  'complete_in_progress',
  'completed',
  'canceled',
  'requires_escalation',
]);
export type UcpStatus = z.infer<typeof UcpStatus>;

export const UcpTotalType = z.enum([
  'subtotal',
  'discount',
  'items_discount',
  'fulfillment',
  'tax',
  'fee',
  'total',
]);
export type UcpTotalType = z.infer<typeof UcpTotalType>;

export const UcpBuyer = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  full_name: z.string().optional(),
  email: z.string().optional(),
  phone_number: z.string().optional(),
});
export type UcpBuyer = z.infer<typeof UcpBuyer>;

/** schema.org-style postal address (UCP `PostalAddress`). */
export const UcpPostalAddress = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  full_name: z.string().optional(),
  phone_number: z.string().optional(),
  street_address: z.string().optional(),
  extended_address: z.string().optional(),
  address_locality: z.string().optional(),
  address_region: z.string().optional(),
  address_country: z.string().optional(),
  postal_code: z.string().optional(),
});
export type UcpPostalAddress = z.infer<typeof UcpPostalAddress>;

/** Fulfillment destination as sent by the platform (flat fields or nested `address`). */
export const UcpDestinationInput = UcpPostalAddress.extend({
  id: z.string().optional(),
  name: z.string().optional(),
  address: UcpPostalAddress.optional(),
});
export type UcpDestinationInput = z.infer<typeof UcpDestinationInput>;

export const UcpGroupInput = z.object({
  id: z.string().optional(),
  selected_option_id: z.string().nullable().optional(),
});

export const UcpMethodInput = z.object({
  type: z.string().optional(), // 'shipping' | 'pickup' | 'digital'; only shipping is quoted in v1
  destinations: z.array(UcpDestinationInput).optional(),
  selected_destination_id: z.string().nullable().optional(),
  groups: z.array(UcpGroupInput).optional(),
  line_item_ids: z.array(z.string()).optional(),
});
export type UcpMethodInput = z.infer<typeof UcpMethodInput>;

export const UcpFulfillmentInput = z.object({
  methods: z.array(UcpMethodInput).optional(),
});
export type UcpFulfillmentInput = z.infer<typeof UcpFulfillmentInput>;

const UcpLineItemInput = z.object({
  id: z.string().optional(),
  item: z.object({ id: z.string() }),
  quantity: z.number().int().positive(),
});
export type UcpLineItemInput = z.infer<typeof UcpLineItemInput>;

/** Payment credential on a complete-call instrument. `token` is the gateway
 * token our PSP settles (Stripe payment method / gateway token). */
export const UcpPaymentCredential = z.object({
  type: z.string().optional(),
  token: z.string().optional(),
});

export const UcpPaymentInstrumentInput = z.object({
  id: z.string().optional(),
  handler_id: z.string().optional(),
  type: z.string().optional(),
  credential: UcpPaymentCredential.optional(),
  billing_address: UcpPostalAddress.optional(),
});
export type UcpPaymentInstrumentInput = z.infer<typeof UcpPaymentInstrumentInput>;

// ---- Inbound request bodies (lenient) ----

export const UcpCreateRequest = z.object({
  buyer: UcpBuyer.optional(),
  currency: z.string().optional(), // catalog currency is authoritative
  line_items: z.array(UcpLineItemInput).min(1),
  payment: z.object({}).passthrough().optional(),
  fulfillment: UcpFulfillmentInput.optional(),
});
export type UcpCreateRequest = z.infer<typeof UcpCreateRequest>;

/** PUT is full replacement per spec; we treat omitted fields as "keep". */
export const UcpUpdateRequest = z.object({
  buyer: UcpBuyer.optional(),
  currency: z.string().optional(),
  id: z.string().optional(),
  line_items: z.array(UcpLineItemInput).optional(),
  payment: z.object({}).passthrough().optional(),
  fulfillment: UcpFulfillmentInput.optional(),
});
export type UcpUpdateRequest = z.infer<typeof UcpUpdateRequest>;

export const UcpCompleteRequest = z.object({
  payment_data: UcpPaymentInstrumentInput,
  risk_signals: z.record(z.string(), z.unknown()).optional(),
});
export type UcpCompleteRequest = z.infer<typeof UcpCompleteRequest>;

// ---- Response sub-objects ----

export interface UcpItem {
  id: string;
  title: string;
  price: number;
  image_url?: string;
}

export interface UcpTotal {
  type: UcpTotalType;
  amount: number;
  display_text?: string;
}

export interface UcpLineItem {
  id: string;
  item: UcpItem;
  quantity: number;
  totals: UcpTotal[];
}

export interface UcpMessage {
  type: 'error' | 'warning' | 'info';
  code?: string;
  content: string;
  content_type?: 'plain' | 'markdown';
  path?: string;
  severity?: 'recoverable' | 'requires_buyer_input' | 'requires_buyer_review';
}

export interface UcpFulfillmentOption {
  id: string;
  title: string;
  description?: string;
  carrier?: string;
  earliest_fulfillment_time?: string;
  latest_fulfillment_time?: string;
  subtotal?: number;
  tax?: number;
  total: number;
}

export interface UcpDestination extends UcpPostalAddress {
  id: string;
  name?: string;
}

export interface UcpGroup {
  id: string;
  line_item_ids: string[];
  options: UcpFulfillmentOption[];
  selected_option_id?: string | null;
}

export interface UcpMethod {
  id: string;
  type: string;
  line_item_ids: string[];
  destinations?: UcpDestination[];
  selected_destination_id?: string | null;
  groups?: UcpGroup[];
}

export interface UcpFulfillment {
  methods?: UcpMethod[];
}

export interface UcpPaymentHandler {
  id: string;
  name: string;
  version: string;
  spec: string;
  config_schema: string;
  instrument_schemas: string[];
  config: Record<string, unknown>;
}

export interface UcpPayment {
  handlers: UcpPaymentHandler[];
  selected_instrument_id?: string;
}

export interface UcpLink {
  type: string;
  url: string;
  title?: string;
}

/** Per-response protocol envelope: version + capabilities this session used. */
export interface UcpEnvelope {
  version: string;
  capabilities: Array<{ name: string; version: string }>;
}

export interface UcpCheckoutSession {
  id: string;
  status: UcpStatus;
  currency: string;
  buyer?: UcpBuyer;
  line_items: UcpLineItem[];
  fulfillment?: UcpFulfillment;
  payment: UcpPayment;
  totals: UcpTotal[];
  messages: UcpMessage[];
  links: UcpLink[];
  order_id?: string;
  order_permalink_url?: string;
  expires_at?: string;
  ucp: UcpEnvelope;
}

/** Capability list stamped on every session response. */
export function ucpEnvelope(): UcpEnvelope {
  return {
    version: UCP_VERSION,
    capabilities: [
      { name: 'dev.ucp.shopping.checkout', version: UCP_VERSION },
      { name: 'dev.ucp.shopping.fulfillment', version: UCP_VERSION },
    ],
  };
}
