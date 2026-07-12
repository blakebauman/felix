/**
 * Embeddable storefront widget — loader script + per-brand frame document.
 */

import { env, SELF } from 'cloudflare:test';
import type { Env as AppEnv } from '@felix/harness/env';
import { beforeAll, describe, expect, it } from 'vitest';

const testEnv = env as unknown as AppEnv;
const JSON_HEADERS = { 'content-type': 'application/json' };

beforeAll(async () => {
  await SELF.fetch('https://o.test/brands', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      id: 'widgetco',
      name: 'Widget & Co <script>',
      identity: { greeting: 'Welcome to Widget Co!', theme: { accent: '#ff0066' } },
    }),
  });
});

describe('widget loader', () => {
  it('serves loader.js as JavaScript that opens the frame', async () => {
    const r = await SELF.fetch('https://o.test/widget/loader.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    const js = await r.text();
    expect(js).toContain('data-storefront');
    expect(js).toContain('/widget/frame');
  });
});

describe('widget frame', () => {
  it('renders a themed, SSR brand frame that targets the /shop endpoint', async () => {
    const r = await SELF.fetch('https://o.test/widget/frame?storefront=widgetco');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    // Embeddable cross-origin.
    expect(r.headers.get('content-security-policy')).toContain('frame-ancestors');
    const html = await r.text();
    expect(html).toContain('Welcome to Widget Co!');
    // Client JS builds the URL from these parts at runtime.
    expect(html).toContain("'/shop/'");
    expect(html).toContain('"widgetco"'); // STOREFRONT injected via JSON.stringify
    expect(html).toContain('#ff0066'); // accent theme token applied
  });

  it('HTML-escapes the brand name (no raw script injection)', async () => {
    const r = await SELF.fetch('https://o.test/widget/frame?storefront=widgetco');
    const html = await r.text();
    expect(html).toContain('Widget &amp; Co &lt;script&gt;');
    expect(html).not.toContain('Widget & Co <script>');
  });

  it('404s an unknown storefront', async () => {
    const r = await SELF.fetch('https://o.test/widget/frame?storefront=ghost');
    expect(r.status).toBe(404);
  });
});
