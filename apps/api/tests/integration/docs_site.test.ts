/**
 * Prose-docs redirects.
 *
 * The guide/internals/commerce markdown ships as a separate static site
 * (`packages/docs`, Starlight at docs.felix.run). The Worker keeps the old
 * `/docs/home` · `/docs/guide/*` · `/docs/internals/*` routes as 301s so
 * agent-card and OpenAPI "Read more" links keep resolving. The exact `/docs`
 * route stays owned by the Scalar API reference (regression guarded below).
 */

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const DOCS_SITE = 'https://docs.felix.run';

describe('Prose docs redirects', () => {
  it('redirects /docs/home to the docs site index', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/docs/home', { redirect: 'manual' });
    expect(resp.status).toBe(301);
    expect(resp.headers.get('location')).toBe(`${DOCS_SITE}/`);
  });

  it('redirects a guide page', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/docs/guide/concepts', {
      redirect: 'manual',
    });
    expect(resp.status).toBe(301);
    expect(resp.headers.get('location')).toBe(`${DOCS_SITE}/guide/concepts/`);
  });

  it('redirects an internals page', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/docs/internals/persistence', {
      redirect: 'manual',
    });
    expect(resp.status).toBe(301);
    expect(resp.headers.get('location')).toBe(`${DOCS_SITE}/internals/persistence/`);
  });

  it('maps the moved commerce internals page to the Commerce section', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/docs/internals/commerce', {
      redirect: 'manual',
    });
    expect(resp.status).toBe(301);
    expect(resp.headers.get('location')).toBe(`${DOCS_SITE}/commerce/`);
  });

  it('keeps exact /docs on the Scalar API reference (no shadowing)', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/docs');
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/text\/html/);
    const html = await resp.text();
    expect(html).toMatch(/openapi\.json/);
  });

  it('themes Scalar with both schemes of the shared design system', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/docs');
    const html = await resp.text();
    // Both light and dark variable blocks from src/design/tokens.ts, and no
    // forced light mode — the toggle must be available to match the docs site.
    expect(html).toContain('.light-mode');
    expect(html).toContain('.dark-mode');
    expect(html).not.toMatch(/forceDarkModeState/);
  });
});
