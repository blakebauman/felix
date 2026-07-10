/**
 * schema.org / JSON-LD mappers (pure).
 */

import type { Brand } from '@felix/commerce/brands/models';
import type { Product } from '@felix/commerce/models';
import {
  brandToOrganization,
  breadcrumbFor,
  feedToItemList,
  productToJsonLd,
} from '@felix/commerce/structured/jsonld';
import { describe, expect, it } from 'vitest';

function brand(): Brand {
  return {
    tenant_id: 'op',
    id: 'acme',
    brand_tenant: 'acme',
    name: 'Acme Co',
    identity: {
      greeting: '',
      logo_url: 'https://cdn.acme.test/logo.png',
      support_email: 'help@acme.test',
      theme: {},
      prompt_extra: '',
      structured_data: { enabled: true, canonical_base_url: '', gtin_attr: 'gtin' },
    },
    status: 'active',
    created_at: 1,
    updated_at: 1,
  };
}

function product(over: Partial<Product> = {}): Product {
  return {
    tenant_id: 'acme',
    id: 'tee-001',
    title: 'Classic Tee',
    description: 'Soft cotton tee',
    price_cents: 2500,
    currency: 'usd',
    image_url: 'https://cdn.acme.test/tee.png',
    category: 'apparel',
    inventory: 10,
    active: true,
    attrs: { brand: 'Acme', gtin: '00012345678905', material: 'cotton', size: 'M' },
    created_at: 1,
    ...over,
  };
}

const opts = { baseUrl: 'https://acme.test' };

describe('productToJsonLd', () => {
  it('maps catalog fields to schema.org Product/Offer', () => {
    const node = productToJsonLd(product(), brand(), opts);
    expect(node['@type']).toBe('Product');
    expect(node['@id']).toBe('https://acme.test/products/tee-001');
    expect(node.name).toBe('Classic Tee');
    expect(node.sku).toBe('tee-001');
    expect(node.gtin).toBe('00012345678905');
    expect(node.brand).toEqual({ '@type': 'Brand', name: 'Acme' });
    expect(node.offers.price).toBe('25.00');
    expect(node.offers.priceCurrency).toBe('USD');
    expect(node.offers.availability).toBe('https://schema.org/InStock');
    expect(node.offers.seller.name).toBe('Acme Co');
  });

  it('surfaces non-reserved attrs as additionalProperty (GS1-style)', () => {
    const node = productToJsonLd(product(), brand(), opts);
    const names = (node.additionalProperty ?? []).map((p) => p.name).sort();
    expect(names).toEqual(['material', 'size']); // brand + gtin are reserved
    const material = node.additionalProperty?.find((p) => p.name === 'material');
    expect(material?.value).toBe('cotton');
  });

  it('marks zero inventory out of stock', () => {
    const node = productToJsonLd(product({ inventory: 0 }), brand(), opts);
    expect(node.offers.availability).toBe('https://schema.org/OutOfStock');
  });

  it('treats unlimited inventory (-1) as in stock', () => {
    const node = productToJsonLd(product({ inventory: -1 }), brand(), opts);
    expect(node.offers.availability).toBe('https://schema.org/InStock');
  });

  it('falls back to the brand name when no brand attr', () => {
    const node = productToJsonLd(product({ attrs: {} }), brand(), opts);
    expect(node.brand.name).toBe('Acme Co');
    expect(node.gtin).toBeUndefined();
    expect(node.additionalProperty).toBeUndefined();
  });
});

describe('ratings & reviews', () => {
  it('maps attrs.rating / review_count to AggregateRating and omits them from additionalProperty', () => {
    const node = productToJsonLd(
      product({ attrs: { rating: 4.6, review_count: 128, material: 'cotton' } }),
      brand(),
      opts,
    );
    expect(node.aggregateRating).toEqual({
      '@type': 'AggregateRating',
      ratingValue: '4.6',
      reviewCount: 128,
    });
    const names = (node.additionalProperty ?? []).map((p) => p.name);
    expect(names).not.toContain('rating');
    expect(names).not.toContain('review_count');
    expect(names).toContain('material');
  });

  it('omits aggregateRating when there is no rating', () => {
    const node = productToJsonLd(product({ attrs: {} }), brand(), opts);
    expect(node.aggregateRating).toBeUndefined();
    expect(node.review).toBeUndefined();
  });

  it('maps a structured attrs.reviews array to schema.org Review[]', () => {
    const node = productToJsonLd(
      product({ attrs: { reviews: [{ author: 'Sam', rating: 5, body: 'Great' }, { rating: 3 }] } }),
      brand(),
      opts,
    );
    expect(node.review).toHaveLength(2);
    expect(node.review?.[0]).toEqual({
      '@type': 'Review',
      author: { '@type': 'Person', name: 'Sam' },
      reviewRating: { '@type': 'Rating', ratingValue: '5.0' },
      reviewBody: 'Great',
    });
  });
});

describe('breadcrumbFor', () => {
  it('builds Home → category → product with 1-based positions', () => {
    const list = breadcrumbFor(product(), brand(), opts);
    expect(list['@type']).toBe('BreadcrumbList');
    expect(list.itemListElement.map((e) => e.name)).toEqual(['Home', 'apparel', 'Classic Tee']);
    expect(list.itemListElement.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(list.itemListElement[2]?.item).toBe('https://acme.test/products/tee-001');
  });

  it('skips the category level when the product has no category', () => {
    const list = breadcrumbFor(product({ category: '' }), brand(), opts);
    expect(list.itemListElement.map((e) => e.name)).toEqual(['Home', 'Classic Tee']);
  });
});

describe('feedToItemList', () => {
  it('wraps products in an ItemList with 1-based positions', () => {
    const list = feedToItemList([product(), product({ id: 'tee-002' })], brand(), opts);
    expect(list['@type']).toBe('ItemList');
    expect(list.numberOfItems).toBe(2);
    expect(list.itemListElement[0]?.position).toBe(1);
    expect(list.itemListElement[1]?.item['@id']).toBe('https://acme.test/products/tee-002');
  });
});

describe('brandToOrganization', () => {
  it('includes logo + email when present, omits empty url', () => {
    const org = brandToOrganization(brand(), '');
    expect(org.name).toBe('Acme Co');
    expect(org.logo).toBe('https://cdn.acme.test/logo.png');
    expect(org.email).toBe('help@acme.test');
    expect(org.url).toBeUndefined();
  });
});
