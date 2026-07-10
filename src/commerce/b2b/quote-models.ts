/**
 * Quote-to-cash models (Zod). Money in integer cents.
 */

import { z } from '@hono/zod-openapi';

export const QuoteStatus = z.enum([
  'draft',
  'sent',
  'accepted',
  'pending_approval',
  'ordered',
  'rejected',
  'expired',
  'cancelled',
]);
export type QuoteStatus = z.infer<typeof QuoteStatus>;

export const QuoteItem = z
  .object({
    product_id: z.string().min(1),
    title: z.string().default(''),
    qty: z.number().int().positive(),
    unit_price_cents: z.number().int().nonnegative(),
    discount_cents: z.number().int().nonnegative().default(0),
    line_total_cents: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('QuoteItem');
export type QuoteItem = z.infer<typeof QuoteItem>;

export const Quote = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: z.string().min(1),
    account_id: z.string().min(1),
    buyer_id: z.string().min(1),
    status: QuoteStatus.default('draft'),
    currency: z.string().default('usd'),
    subtotal_cents: z.number().int().nonnegative().default(0),
    discount_cents: z.number().int().nonnegative().default(0),
    total_cents: z.number().int().nonnegative().default(0),
    valid_until: z.number().int().nullable().default(null),
    approval_id: z.string().default(''),
    order_id: z.string().default(''),
    notes: z.string().default(''),
    items: z.array(QuoteItem).default([]),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict()
  .openapi('Quote');
export type Quote = z.infer<typeof Quote>;

export const InvoiceStatus = z.enum(['open', 'paid', 'void']);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

export const Invoice = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: z.string().min(1),
    account_id: z.string().min(1),
    quote_id: z.string().default(''),
    order_id: z.string().default(''),
    amount_cents: z.number().int().nonnegative(),
    currency: z.string().default('usd'),
    terms: z.string().default('prepaid'),
    status: InvoiceStatus.default('open'),
    due_at: z.number().int(),
    created_at: z.number().int(),
    paid_at: z.number().int().nullable().default(null),
    provider: z.string().default('internal'),
    external_ref: z.string().default(''),
    hosted_url: z.string().default(''),
  })
  .strict()
  .openapi('Invoice');
export type Invoice = z.infer<typeof Invoice>;

// ---- requests ----

export const QuoteLineInput = z
  .object({
    product_id: z.string().min(1),
    qty: z.number().int().positive(),
    /** Seller-negotiated overrides; default to catalog price + no discount. */
    unit_price_cents: z.number().int().nonnegative().optional(),
    discount_cents: z.number().int().nonnegative().optional(),
  })
  .strict();

export const CreateQuoteRequest = z
  .object({
    account_id: z.string().min(1),
    buyer_id: z.string().min(1),
    items: z.array(QuoteLineInput).min(1),
    notes: z.string().optional(),
  })
  .strict()
  .openapi('CreateQuoteRequest');
export type CreateQuoteRequest = z.infer<typeof CreateQuoteRequest>;

export const SendQuoteRequest = z
  .object({ valid_days: z.number().int().positive().max(365).optional() })
  .strict()
  .openapi('SendQuoteRequest');
export type SendQuoteRequest = z.infer<typeof SendQuoteRequest>;
