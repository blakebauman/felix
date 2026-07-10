/**
 * schema.org / JSON-LD mappers. Pure (no I/O) so they unit-test without bindings,
 * mirroring the ACP `feed.ts` style.
 *
 * These render the D1 catalog into machine-readable structured data that
 * generative engines and AI crawlers parse — the discoverability surface the
 * ACP feed (agent-to-agent) does not cover. Field semantics follow schema.org's
 * Product / Offer / Organization vocabulary; GS1-style attributes (dimensions,
 * compatibility, certifications, ...) ride on `additionalProperty`.
 *
 * Money is integer cents in the catalog; schema.org `price` is a decimal string.
 */

import type { Brand } from '../brands/models';
import type { Product } from '../models';

const IN_STOCK = 'https://schema.org/InStock';
const OUT_OF_STOCK = 'https://schema.org/OutOfStock';
const NEW_CONDITION = 'https://schema.org/NewCondition';

/** Attribute keys mapped to schema.org rating/review fields. */
const RATING_ATTR = 'rating';
const REVIEW_COUNT_ATTR = 'review_count';
const REVIEWS_ATTR = 'reviews';

/** Attribute keys consumed into first-class fields rather than additionalProperty. */
function reservedAttrs(gtinAttr: string): Set<string> {
  return new Set(['brand', gtinAttr, RATING_ATTR, REVIEW_COUNT_ATTR, REVIEWS_ATTR]);
}

function priceDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

function availabilityUrl(p: Product): string {
  return p.inventory === 0 ? OUT_OF_STOCK : IN_STOCK;
}

function productUrl(baseUrl: string, id: string): string {
  return `${baseUrl}/products/${encodeURIComponent(id)}`;
}

export interface JsonLdOrganization {
  '@type': 'Organization';
  name: string;
  url?: string;
  logo?: string;
  email?: string;
}

export interface JsonLdAggregateRating {
  '@type': 'AggregateRating';
  ratingValue: string;
  reviewCount?: number;
}

export interface JsonLdReview {
  '@type': 'Review';
  author: { '@type': 'Person'; name: string };
  reviewRating: { '@type': 'Rating'; ratingValue: string };
  reviewBody?: string;
}

export interface JsonLdProduct {
  '@context': 'https://schema.org';
  '@type': 'Product';
  '@id': string;
  name: string;
  description?: string;
  sku: string;
  mpn: string;
  image?: string;
  category?: string;
  gtin?: string;
  brand: { '@type': 'Brand'; name: string };
  additionalProperty?: Array<{ '@type': 'PropertyValue'; name: string; value: string }>;
  aggregateRating?: JsonLdAggregateRating;
  review?: JsonLdReview[];
  offers: {
    '@type': 'Offer';
    url: string;
    priceCurrency: string;
    price: string;
    availability: string;
    itemCondition: string;
    seller: JsonLdOrganization;
  };
}

/** Breadcrumb trail (Home → category → product), aiding AI/crawler navigation. */
export interface JsonLdBreadcrumbList {
  '@context': 'https://schema.org';
  '@type': 'BreadcrumbList';
  itemListElement: Array<{ '@type': 'ListItem'; position: number; name: string; item: string }>;
}

export interface JsonLdItemList {
  '@context': 'https://schema.org';
  '@type': 'ItemList';
  numberOfItems: number;
  itemListElement: Array<{ '@type': 'ListItem'; position: number; item: JsonLdProduct }>;
}

export interface StructuredOpts {
  baseUrl: string;
  gtinAttr?: string;
}

export function brandToOrganization(brand: Brand, baseUrl: string): JsonLdOrganization {
  const org: JsonLdOrganization = { '@type': 'Organization', name: brand.name };
  if (baseUrl) org.url = baseUrl;
  if (brand.identity.logo_url) org.logo = brand.identity.logo_url;
  if (brand.identity.support_email) org.email = brand.identity.support_email;
  return org;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number.parseFloat(v);
  return Number.NaN;
}

/** schema.org AggregateRating from `attrs.rating` / `attrs.review_count`, if present. */
function aggregateRatingFrom(p: Product): JsonLdAggregateRating | undefined {
  const value = toNumber(p.attrs[RATING_ATTR]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const node: JsonLdAggregateRating = { '@type': 'AggregateRating', ratingValue: value.toFixed(1) };
  const count = toNumber(p.attrs[REVIEW_COUNT_ATTR]);
  if (Number.isFinite(count) && count > 0) node.reviewCount = Math.trunc(count);
  return node;
}

/** schema.org Review[] from a structured `attrs.reviews` array, if present. */
function reviewsFrom(p: Product): JsonLdReview[] | undefined {
  const raw = p.attrs[REVIEWS_ATTR];
  if (!Array.isArray(raw)) return undefined;
  const out: JsonLdReview[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const rating = toNumber(o.rating);
    if (!Number.isFinite(rating)) continue;
    const review: JsonLdReview = {
      '@type': 'Review',
      author: { '@type': 'Person', name: String(o.author ?? 'Anonymous') },
      reviewRating: { '@type': 'Rating', ratingValue: rating.toFixed(1) },
    };
    if (typeof o.body === 'string' && o.body) review.reviewBody = o.body;
    out.push(review);
  }
  return out.length ? out : undefined;
}

/** Build a BreadcrumbList (Home → category → product) for a product page. */
export function breadcrumbFor(
  p: Product,
  _brand: Brand,
  opts: StructuredOpts,
): JsonLdBreadcrumbList {
  const baseUrl = opts.baseUrl;
  const elements: JsonLdBreadcrumbList['itemListElement'] = [
    { '@type': 'ListItem', position: 1, name: 'Home', item: baseUrl },
  ];
  let position = 2;
  if (p.category) {
    elements.push({
      '@type': 'ListItem',
      position: position++,
      name: p.category,
      item: `${baseUrl}/category/${encodeURIComponent(p.category)}`,
    });
  }
  elements.push({
    '@type': 'ListItem',
    position,
    name: p.title,
    item: productUrl(baseUrl, p.id),
  });
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: elements };
}

export function productToJsonLd(p: Product, brand: Brand, opts: StructuredOpts): JsonLdProduct {
  const gtinAttr = opts.gtinAttr ?? 'gtin';
  const reserved = reservedAttrs(gtinAttr);
  const baseUrl = opts.baseUrl;
  const seller = brandToOrganization(brand, baseUrl);

  const additionalProperty = Object.entries(p.attrs)
    .filter(([k, v]) => !reserved.has(k) && v != null && v !== '')
    .map(([name, value]) => ({
      '@type': 'PropertyValue' as const,
      name,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    }));

  const node: JsonLdProduct = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': productUrl(baseUrl, p.id),
    name: p.title,
    sku: p.id,
    mpn: p.id,
    brand: { '@type': 'Brand', name: (p.attrs.brand as string) || brand.name },
    offers: {
      '@type': 'Offer',
      url: productUrl(baseUrl, p.id),
      priceCurrency: p.currency.toUpperCase(),
      price: priceDecimal(p.price_cents),
      availability: availabilityUrl(p),
      itemCondition: NEW_CONDITION,
      seller,
    },
  };
  if (p.description) node.description = p.description;
  if (p.image_url) node.image = p.image_url;
  if (p.category) node.category = p.category;
  const gtin = p.attrs[gtinAttr];
  if (typeof gtin === 'string' && gtin) node.gtin = gtin;
  if (additionalProperty.length) node.additionalProperty = additionalProperty;
  const aggregateRating = aggregateRatingFrom(p);
  if (aggregateRating) node.aggregateRating = aggregateRating;
  const review = reviewsFrom(p);
  if (review) node.review = review;
  return node;
}

export function feedToItemList(
  products: Product[],
  brand: Brand,
  opts: StructuredOpts,
): JsonLdItemList {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    numberOfItems: products.length,
    itemListElement: products.map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: productToJsonLd(p, brand, opts),
    })),
  };
}
