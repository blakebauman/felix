/**
 * Brand manifest overlay + catalog import mapping (pure logic).
 */

import { loadManifest } from '@felix/harness/manifests/loader';
import { describe, expect, it } from 'vitest';
import { parsePrice } from '../src/brands/import';
import type { Brand } from '../src/brands/models';
import { buildBrandManifest } from '../src/brands/provision';

function brand(over: Partial<Brand> = {}): Brand {
  return {
    tenant_id: 'op',
    id: 'acme',
    brand_tenant: 'acme',
    name: 'Acme Co',
    identity: {
      greeting: 'Welcome to Acme!',
      logo_url: '',
      support_email: 'help@acme.test',
      theme: {},
      prompt_extra: 'Always upsell the extended warranty.',
      structured_data: { enabled: true, canonical_base_url: '', gtin_attr: 'gtin' },
      ...over.identity,
    },
    status: 'active',
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe('buildBrandManifest', () => {
  it('overlays brand identity onto the base orderloop manifest', () => {
    const base = loadManifest('orderloop');
    const m = buildBrandManifest(base, brand());
    // Inherits the base tool list + checkout approval.
    expect(m.spec.tools).toEqual(base.spec.tools);
    expect(m.spec.approvals.some((a) => a.tools.includes('commerce_checkout'))).toBe(true);
    // Brand voice is injected into the system prompt.
    expect(m.spec.system_prompt.inline).toContain('Acme Co');
    expect(m.spec.system_prompt.inline).toContain('Welcome to Acme!');
    expect(m.spec.system_prompt.inline).toContain('help@acme.test');
    expect(m.spec.system_prompt.inline).toContain('extended warranty');
    // Still resolves under the canonical name and is tagged d2c.
    expect(m.metadata.name).toBe('orderloop');
    expect(m.metadata.tags).toContain('d2c');
    expect(m.metadata.tags).toContain('acme');
  });

  it('produces a schema-valid manifest even with empty identity', () => {
    const base = loadManifest('orderloop');
    const m = buildBrandManifest(
      base,
      brand({
        identity: {
          greeting: '',
          logo_url: '',
          support_email: '',
          theme: {},
          prompt_extra: '',
          structured_data: { enabled: true, canonical_base_url: '', gtin_attr: 'gtin' },
        },
      }),
    );
    expect(m.spec.system_prompt.inline).toContain('Acme Co');
  });
});

describe('parsePrice (ACP feed import)', () => {
  it('parses "amount CODE" into integer cents + lowercase currency', () => {
    expect(parsePrice('25.00 USD')).toEqual({ cents: 2500, currency: 'usd' });
    expect(parsePrice('9.99 EUR')).toEqual({ cents: 999, currency: 'eur' });
  });
  it('defaults currency and zeroes an unparseable amount', () => {
    expect(parsePrice('free')).toEqual({ cents: 0, currency: 'usd' });
  });
});
