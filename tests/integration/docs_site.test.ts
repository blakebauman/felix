/**
 * Prose docs site.
 *
 * The rendered guide/internals docs are served under `/docs/...` sub-paths.
 * The exact `/docs` route stays owned by the Scalar API reference (regression
 * guarded below), since the docs router defines no bare `GET /`.
 */

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Prose docs site', () => {
  it('serves /docs/home with both group navs', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/docs/home');
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/text\/html/);
    const html = await resp.text();
    expect(html).toMatch(/>Guide</);
    expect(html).toMatch(/>Internals</);
    // README H1 renders into the page.
    expect(html).toMatch(/Felix Documentation/);
  });

  it('serves a guide page with intra-doc links rewritten to site routes', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/docs/guide/concepts');
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/text\/html/);
    const html = await resp.text();
    expect(html).toMatch(/<h1[^>]*>Concepts/);
    // A cross-link into internals resolved to an on-site route, not GitHub.
    expect(html).toMatch(/href="\/docs\/internals\//);
    expect(html).not.toMatch(/href="[^"]*\.md"/);
  });

  it('serves an internals page', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/docs/internals/persistence');
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('404s an unknown doc slug', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/docs/guide/does-not-exist');
    expect(resp.status).toBe(404);
  });

  it('keeps exact /docs on the Scalar API reference (no shadowing)', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/docs');
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/text\/html/);
    const html = await resp.text();
    expect(html).toMatch(/openapi\.json/);
  });
});
