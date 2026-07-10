/**
 * Visual-search agent tool. `search_by_image` matches an uploaded image against
 * the catalog's image embeddings. The image is supplied either inline as base64
 * or by an R2 key (where the storefront `visual-search` endpoint stored it).
 * Tenant comes from `getContext()`, like the other commerce tools.
 */

import { getContext } from '@felix/orchestrator/context';
import type { Tool, ToolOutput } from '@felix/orchestrator/tools/types';
import { defineTool } from '@felix/orchestrator/tools/types';
import { z } from 'zod';
import { getProduct } from '../catalog-store';
import { queryByImage } from './embeddings';

function requireCtx(): { env: import('@felix/orchestrator/env').Env; tenantId: string } | string {
  const rc = getContext();
  if (!rc) return '[commerce error] no request context';
  return { env: rc.env, tenantId: rc.auth.principal.tenantId };
}

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Resolve, hydrate, and shape similar products into catalog-card JSON. */
export async function hydrateMatches(
  env: import('@felix/orchestrator/env').Env,
  tenantId: string,
  matches: Array<{ product_id: string }>,
  max: number,
): Promise<string> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const m of matches) {
    if (out.length >= max) break;
    if (!m.product_id || seen.has(m.product_id)) continue;
    seen.add(m.product_id);
    const p = await getProduct(env, tenantId, m.product_id);
    if (!p || !p.active || p.inventory === 0) continue;
    out.push({
      id: p.id,
      title: p.title,
      price_cents: p.price_cents,
      currency: p.currency,
      category: p.category,
      in_stock: p.inventory !== 0,
    });
  }
  return JSON.stringify(out);
}

export function searchByImageTool(): Tool {
  return defineTool({
    name: 'search_by_image',
    description:
      'Find catalog products that visually match an uploaded image. Provide the ' +
      'image as base64 (`image_base64`) or by the storage key returned from an ' +
      'upload (`image_key`). Returns up to `limit` matching products as JSON.',
    args: z
      .object({
        image_base64: z.string().min(1).optional(),
        image_key: z.string().min(1).optional(),
        limit: z.number().int().positive().max(20).optional(),
      })
      .strict(),
    async handler({ image_base64, image_key, limit }): Promise<ToolOutput> {
      const c = requireCtx();
      if (typeof c === 'string') return c;
      const max = limit ?? 5;

      let bytes: Uint8Array | null = null;
      if (image_base64) {
        bytes = decodeBase64(image_base64);
      } else if (image_key) {
        const obj = await c.env.BUNDLES.get(image_key);
        if (obj) bytes = new Uint8Array(await obj.arrayBuffer());
      }
      if (!bytes || bytes.length === 0) {
        return 'Provide an image as `image_base64` or a valid `image_key`.';
      }

      const matches = await queryByImage(c.env, c.tenantId, bytes, max * 2);
      return hydrateMatches(c.env, c.tenantId, matches, max);
    },
  });
}

/** All visual-search tool factories, registered together in composition.ts. */
export function visualToolFactories(): Record<string, () => Tool> {
  return {
    search_by_image: searchByImageTool,
  };
}
