/**
 * B2B domain models (Zod). Money in integer cents. Accounts + buyers are read
 * through the entity data-source seam (native default).
 */

import { z } from '@hono/zod-openapi';

export const PaymentTerms = z.enum(['prepaid', 'net15', 'net30', 'net60']);
export type PaymentTerms = z.infer<typeof PaymentTerms>;

export const BuyerRole = z.enum(['admin', 'approver', 'purchaser', 'viewer']);
export type BuyerRole = z.infer<typeof BuyerRole>;

export const Account = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: z.string().min(1).openapi({ example: 'acme-corp' }),
    name: z.string().min(1),
    status: z.enum(['active', 'suspended']).default('active'),
    payment_terms: PaymentTerms.default('prepaid'),
    credit_limit_cents: z.number().int().nonnegative().default(0),
    currency: z.string().default('usd'),
    metadata: z.record(z.string(), z.unknown()).default({}),
    created_at: z.number().int(),
  })
  .strict()
  .openapi('Account');
export type Account = z.infer<typeof Account>;

export const Buyer = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: z.string().min(1).openapi({ example: 'jane@acme.test' }),
    account_id: z.string().min(1),
    email: z.string().default(''),
    role: BuyerRole.default('purchaser'),
    spending_limit_cents: z.number().int().nonnegative().default(0),
    status: z.enum(['active', 'disabled']).default('active'),
    created_at: z.number().int(),
  })
  .strict()
  .openapi('Buyer');
export type Buyer = z.infer<typeof Buyer>;

export const CreateAccountRequest = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1),
    payment_terms: PaymentTerms.optional(),
    credit_limit_cents: z.number().int().nonnegative().optional(),
    currency: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .openapi('CreateAccountRequest');
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>;

export const CreateBuyerRequest = z
  .object({
    id: z.string().min(1),
    email: z.string().optional(),
    role: BuyerRole.optional(),
    spending_limit_cents: z.number().int().nonnegative().optional(),
  })
  .strict()
  .openapi('CreateBuyerRequest');
export type CreateBuyerRequest = z.infer<typeof CreateBuyerRequest>;

export const PurchaseCheckRequest = z
  .object({
    buyer_id: z.string().min(1),
    amount_cents: z.number().int().positive(),
    note: z.string().optional(),
  })
  .strict()
  .openapi('PurchaseCheckRequest');
export type PurchaseCheckRequest = z.infer<typeof PurchaseCheckRequest>;
