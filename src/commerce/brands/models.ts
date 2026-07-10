/**
 * D2C brand models (Zod). A brand is a per-tenant storefront: identity config
 * + a data tenant under which its catalog, orders, and `orderloop` manifest
 * live. `slug` doubles as the brand id (within the operator tenant) and the
 * default data tenant.
 */

import { z } from '@hono/zod-openapi';

export const BrandIdentity = z
  .object({
    greeting: z.string().default('').openapi({
      description: 'Opening line the storefront agent uses.',
      example: 'Welcome to Acme — how can I help you shop today?',
    }),
    logo_url: z.string().default(''),
    support_email: z.string().default(''),
    theme: z
      .record(z.string(), z.string())
      .default({})
      .openapi({ description: 'Free-form theme tokens (colors, fonts) for the storefront UI.' }),
    prompt_extra: z.string().default('').openapi({
      description: 'Extra brand-voice instructions appended to the agent system prompt.',
    }),
    structured_data: z
      .object({
        enabled: z.boolean().default(true).openapi({
          description: 'Emit schema.org / JSON-LD structured data for this brand at /structured.',
        }),
        canonical_base_url: z.string().default('').openapi({
          description:
            'Absolute base URL for canonical product/offer links (no trailing slash). Empty falls back to the deployment default.',
        }),
        gtin_attr: z.string().default('gtin').openapi({
          description: 'Product `attrs` key holding the GTIN/UPC/EAN, surfaced as schema.org gtin.',
        }),
      })
      .strict()
      .default({ enabled: true, canonical_base_url: '', gtin_attr: 'gtin' })
      .openapi({ description: 'schema.org / JSON-LD machine-readable catalog settings.' }),
  })
  .strict()
  .openapi('BrandIdentity');
export type BrandIdentity = z.infer<typeof BrandIdentity>;

const SLUG = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric/dashes');

export const Brand = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: SLUG.openapi({
      description: 'Brand slug; unique within the operator tenant.',
      example: 'acme',
    }),
    brand_tenant: z.string().min(1),
    name: z.string().min(1),
    identity: BrandIdentity.default(BrandIdentity.parse({})),
    status: z.enum(['active', 'disabled']).default('active'),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict()
  .openapi('Brand');
export type Brand = z.infer<typeof Brand>;

export const CreateBrandRequest = z
  .object({
    id: SLUG,
    name: z.string().min(1),
    identity: BrandIdentity.partial().optional(),
    /** Override the data tenant; defaults to the slug. */
    brand_tenant: z.string().min(1).optional(),
  })
  .strict()
  .openapi('CreateBrandRequest');
export type CreateBrandRequest = z.infer<typeof CreateBrandRequest>;

/** A product as supplied in a plain-JSON catalog import. */
export const ImportProduct = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    price_cents: z.number().int().nonnegative(),
    currency: z.string().optional(),
    image_url: z.string().optional(),
    category: z.string().optional(),
    inventory: z.number().int().optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .openapi('ImportProduct');
export type ImportProduct = z.infer<typeof ImportProduct>;

/** One item in the ACP product-feed import shape (subset we map). */
export const AcpFeedImportItem = z
  .object({
    item_id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    price: z.string().openapi({ description: 'ACP price string, e.g. "25.00 USD".' }),
    image_url: z.string().optional(),
    availability: z.string().optional(),
    category: z.string().optional(),
    inventory_quantity: z.number().int().optional(),
  })
  .openapi('AcpFeedImportItem');
export type AcpFeedImportItem = z.infer<typeof AcpFeedImportItem>;

export const UpdateBrandRequest = z
  .object({
    name: z.string().min(1).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    identity: BrandIdentity.partial().optional(),
  })
  .strict()
  .openapi('UpdateBrandRequest');
export type UpdateBrandRequest = z.infer<typeof UpdateBrandRequest>;

export const RegisterDomainRequest = z
  .object({
    host: z
      .string()
      .min(1)
      .regex(/^[a-z0-9.-]+$/i, 'host must be a bare hostname (no scheme or path)'),
  })
  .strict()
  .openapi('RegisterDomainRequest');
export type RegisterDomainRequest = z.infer<typeof RegisterDomainRequest>;

export const ImportRequest = z
  .discriminatedUnion('format', [
    z.object({ format: z.literal('json'), products: z.array(ImportProduct).min(1) }),
    z.object({ format: z.literal('acp_feed'), products: z.array(AcpFeedImportItem).min(1) }),
  ])
  .openapi('CatalogImportRequest');
export type ImportRequest = z.infer<typeof ImportRequest>;
