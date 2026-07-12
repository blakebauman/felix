/**
 * D2C polish: storefront enable/disable, frame-ancestors locking, and the
 * widget's streaming + rich-rendering wiring (asserted at the served-asset
 * level — the client JS itself isn't executed in tests).
 */

import { env, SELF } from 'cloudflare:test';
import type { Env as AppEnv } from '@felix/harness/env';
import { _clearResolverCache } from '@felix/harness/manifests/resolver';
import { beforeAll, describe, expect, it } from 'vitest';

const testEnv = env as unknown as AppEnv;
const H = { 'content-type': 'application/json' };

async function provision(id: string, name: string) {
  return SELF.fetch('https://o.test/brands', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ id, name }),
  });
}

beforeAll(async () => {
  await provision('offco', 'Off Co');
  await provision('csco', 'CS Co');
  await provision('nodom', 'No Domain Co');
});

describe('storefront enable/disable', () => {
  it('disabling a brand darkens its public storefront, re-enabling restores it', async () => {
    _clearResolverCache();
    // Active first.
    expect((await SELF.fetch('https://o.test/shop/offco/config')).status).toBe(200);

    const patch = await SELF.fetch('https://o.test/brands/offco', {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(patch.status).toBe(200);

    // Public config now 403; widget frame shows an unavailable page (not 404).
    expect((await SELF.fetch('https://o.test/shop/offco/config')).status).toBe(403);
    const frame = await SELF.fetch('https://o.test/widget/frame?storefront=offco');
    expect(frame.status).toBe(200);
    expect(await frame.text()).toContain('unavailable');

    // Re-enable.
    const reenable = await SELF.fetch('https://o.test/brands/offco', {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ status: 'active' }),
    });
    expect(reenable.status).toBe(200);
    expect((await SELF.fetch('https://o.test/shop/offco/config')).status).toBe(200);
  });

  it('updating brand voice re-provisions the manifest', async () => {
    const patch = await SELF.fetch('https://o.test/brands/csco', {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ identity: { greeting: 'Hey from CS Co!' } }),
    });
    expect(patch.status).toBe(200);
    expect(
      ((await patch.json()) as { manifest_version?: number }).manifest_version,
    ).toBeGreaterThan(1);
  });
});

describe('frame-ancestors locking', () => {
  it('restricts embedding to registered domains; permissive only when none', async () => {
    // No domains → permissive.
    const open = await SELF.fetch('https://o.test/widget/frame?storefront=nodom');
    expect(open.headers.get('content-security-policy')).toBe('frame-ancestors *');

    // Register a domain → CSP locks to it.
    await SELF.fetch('https://o.test/brands/csco/domains', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ host: 'shop.csco.com' }),
    });
    const locked = await SELF.fetch('https://o.test/widget/frame?storefront=csco');
    const csp = locked.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("'self'");
    expect(csp).toContain('https://shop.csco.com');
    expect(csp).not.toContain('*');
  });
});

describe('widget streaming + rich rendering wiring', () => {
  it('frame targets the streaming endpoint and renders cards + pay button', async () => {
    const r = await SELF.fetch('https://o.test/widget/frame?storefront=nodom');
    const html = await r.text();
    expect(html).toContain('/chat/stream');
    expect(html).toContain('on_chat_model_stream');
    expect(html).toContain('renderCards');
    expect(html).toContain('Add to cart');
    expect(html).toContain('Complete payment');
  });
});
