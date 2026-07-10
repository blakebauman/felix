/**
 * ACP product feed. Renders our D1 catalog into the Agentic Commerce product
 * feed shape (JSON). Field names follow the OpenAI product-feed spec; `price`
 * is the ACP "amount + ISO-4217 code" string (e.g. "25.00 USD"). Amounts in
 * the catalog are integer cents.
 *
 * Served as a top-level `{ products: [...] }` document from GET /acp/feed so an
 * agent can ingest the whole catalog for one merchant tenant.
 */

import type { Env } from '@felix/orchestrator/env';
import { listProductsPage } from '../catalog-store';
import type { Product } from '../models';

const SELLER_NAME = 'Orderloop';
const SELLER_URL = 'https://shop.felix.run';

function priceString(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

function availability(p: Product): string {
  if (p.inventory === 0) return 'out_of_stock';
  return 'in_stock';
}

export interface AcpFeedItem {
  item_id: string;
  title: string;
  description: string;
  url: string;
  brand: string;
  image_url: string;
  price: string;
  availability: string;
  seller_name: string;
  seller_url: string;
  is_eligible_search: boolean;
  is_eligible_checkout: boolean;
  store_country: string;
  target_countries: string[];
  seller_privacy_policy: string;
  seller_tos: string;
}

function toFeedItem(p: Product): AcpFeedItem {
  return {
    item_id: p.id,
    title: p.title,
    description: p.description,
    url: `${SELLER_URL}/products/${p.id}`,
    brand: (p.attrs.brand as string) || SELLER_NAME,
    image_url: p.image_url,
    price: priceString(p.price_cents, p.currency),
    availability: availability(p),
    seller_name: SELLER_NAME,
    seller_url: SELLER_URL,
    is_eligible_search: true,
    is_eligible_checkout: p.inventory !== 0,
    store_country: 'US',
    target_countries: ['US'],
    seller_privacy_policy: `${SELLER_URL}/privacy`,
    seller_tos: `${SELLER_URL}/terms`,
  };
}

const DEFAULT_PAGE = 100;

export async function buildFeed(
  env: Env,
  tenantId: string,
  page: { limit?: number; offset?: number } = {},
): Promise<{ products: AcpFeedItem[]; has_more: boolean; offset: number; limit: number }> {
  const limit = page.limit && page.limit > 0 ? page.limit : DEFAULT_PAGE;
  const offset = page.offset && page.offset > 0 ? page.offset : 0;
  const { products, has_more } = await listProductsPage(env, tenantId, { limit, offset });
  return { products: products.map(toFeedItem), has_more, offset, limit };
}
