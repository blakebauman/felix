/**
 * GEO / AEO monitoring models (Zod). `GeoQuery` mirrors the `geo_queries` table;
 * `GeoObservation` mirrors `geo_observations`. A query is a shopping-style prompt
 * the operator wants to track; each cron tick produces one observation per query.
 */

import { z } from '@hono/zod-openapi';

export const GeoEngine = z.enum(['workers_ai', 'openai', 'anthropic']);
export type GeoEngine = z.infer<typeof GeoEngine>;

export const GeoQuery = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: z.string().min(1),
    brand_id: z.string().default(''),
    query_text: z.string().min(1).openapi({
      description:
        'Shopping-style prompt to monitor, e.g. "best waterproof hiking boots under $150".',
    }),
    engine: GeoEngine.default('workers_ai'),
    active: z.boolean().default(true),
    created_at: z.number().int(),
  })
  .strict()
  .openapi('GeoQuery');
export type GeoQuery = z.infer<typeof GeoQuery>;

export const GeoObservation = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: z.string().min(1),
    query_id: z.string().min(1),
    brand_id: z.string().default(''),
    engine: z.string().default(''),
    ts: z.number().int(),
    brand_mentioned: z.boolean().default(false),
    rank: z.number().int().nonnegative().default(0).openapi({
      description: '1-based position of the brand in the answer; 0 = not present.',
    }),
    competitors: z.array(z.string()).default([]),
    products: z.array(z.string()).default([]),
    answer_excerpt: z.string().default(''),
  })
  .strict()
  .openapi('GeoObservation');
export type GeoObservation = z.infer<typeof GeoObservation>;

export const CreateGeoQueryRequest = z
  .object({
    id: z.string().min(1).optional(),
    brand_id: z.string().optional(),
    query_text: z.string().min(1),
    engine: GeoEngine.optional(),
  })
  .strict()
  .openapi('CreateGeoQueryRequest');
export type CreateGeoQueryRequest = z.infer<typeof CreateGeoQueryRequest>;
