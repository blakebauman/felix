/**
 * Public prose-docs site.
 *
 * Serves the bundled guide/internals Markdown (rendered to HTML at build
 * time by `scripts/bundle-docs.ts`) under `/docs/...` sub-paths. The exact
 * `/docs` route is owned by the Scalar API reference (see `src/app.ts`);
 * this router deliberately defines no bare `GET /`, so it never shadows it.
 *
 * Layout is a single self-contained HTML document per page (inline CSS, no
 * external assets) themed to match Scalar's purple reference UI.
 */
import { Hono } from 'hono';
import { html, raw } from 'hono/html';
import type { Env } from '../env';
import { BUNDLED_DOC_BY_SLUG, BUNDLED_DOCS, type DocEntry } from './bundled';

const FAVICON = 'https://make.felix.run/favicon.svg';

function sortedGroup(group: DocEntry['group']): DocEntry[] {
  return BUNDLED_DOCS.filter((d) => d.group === group).sort((a, b) => a.order - b.order);
}

function routeFor(d: DocEntry): string {
  return d.slug === 'index' ? '/docs/home' : `/docs/${d.slug}`;
}

function navLinks(items: DocEntry[], activeSlug: string): string {
  return items
    .map((d) => {
      const cls = d.slug === activeSlug ? ' class="active"' : '';
      return `<li><a href="${routeFor(d)}"${cls}>${escapeHtml(d.title)}</a></li>`;
    })
    .join('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSidebar(activeSlug: string): string {
  const overview = BUNDLED_DOC_BY_SLUG.index;
  const guide = sortedGroup('guide');
  const internals = sortedGroup('internals');
  return `
    <nav class="sidebar">
      <a class="brand" href="/docs/home">Felix <span>docs</span></a>
      ${
        overview
          ? `<ul><li><a href="/docs/home"${
              activeSlug === 'index' ? ' class="active"' : ''
            }>Overview</a></li></ul>`
          : ''
      }
      ${guide.length ? `<h3>Guide</h3><ul>${navLinks(guide, activeSlug)}</ul>` : ''}
      ${internals.length ? `<h3>Internals</h3><ul>${navLinks(internals, activeSlug)}</ul>` : ''}
      <div class="sidebar-foot">
        <a href="/docs">API reference →</a>
      </div>
    </nav>`;
}

const STYLE = `
  /* Neutral monochrome palette — white background, near-black text, subtle
     gray accents (mirrors Tailwind's neutral scale). The active nav item
     uses a light-gray fill; links are near-black. */
  :root {
    --bg: #ffffff; --panel: #fafafa; --border: #e5e5e5; --text: #0a0a0a;
    --muted: #737373; --accent: #171717; --accent-2: #f5f5f5; --code-bg: #f5f5f5;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .layout { display: flex; min-height: 100vh; }
  .sidebar {
    width: 280px; flex: 0 0 280px; background: var(--panel);
    border-right: 1px solid var(--border); padding: 24px 20px;
    position: sticky; top: 0; height: 100vh; overflow-y: auto;
  }
  .sidebar .brand { font-size: 18px; font-weight: 700; color: var(--text); display: block; margin-bottom: 20px; }
  .sidebar .brand span { color: var(--accent); font-weight: 600; }
  .sidebar h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 22px 0 8px; }
  .sidebar ul { list-style: none; margin: 0; padding: 0; }
  .sidebar li a { display: block; padding: 5px 10px; border-radius: 6px; color: var(--muted); font-size: 14px; }
  .sidebar li a:hover { background: var(--code-bg); color: var(--text); text-decoration: none; }
  .sidebar li a.active { background: var(--accent-2); color: #0a0a0a; font-weight: 600; }
  .sidebar-foot { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 13px; }
  .content { flex: 1 1 auto; max-width: 860px; padding: 48px 56px 96px; overflow-x: hidden; }
  .content h1 { font-size: 32px; line-height: 1.2; margin: 0 0 24px; }
  .content h2 { font-size: 24px; margin: 40px 0 14px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .content h3 { font-size: 19px; margin: 30px 0 10px; }
  .content p, .content li { color: var(--text); }
  .content code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 0.88em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .content pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; overflow-x: auto; }
  .content pre code { background: none; padding: 0; }
  .content a { word-break: break-word; }
  .content table { border-collapse: collapse; width: 100%; margin: 18px 0; font-size: 14px; }
  .content th, .content td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
  .content th { background: var(--code-bg); }
  .content blockquote { border-left: 3px solid #d4d4d4; margin: 18px 0; padding: 4px 18px; color: var(--muted); }
  .content img { max-width: 100%; }
  @media (max-width: 760px) {
    .layout { flex-direction: column; }
    .sidebar { width: 100%; height: auto; position: static; border-right: none; border-bottom: 1px solid var(--border); }
    .content { padding: 28px 22px 64px; }
  }
`;

function renderDocPage(activeSlug: string, bodyHtml: string, pageTitle: string) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${pageTitle} · Felix docs</title>
    <link rel="icon" href="${FAVICON}" />
    <style>${raw(STYLE)}</style>
  </head>
  <body>
    <div class="layout">
      ${raw(renderSidebar(activeSlug))}
      <main class="content">${raw(bodyHtml)}</main>
    </div>
  </body>
</html>`;
}

export function buildDocsSiteRouter(): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>();

  // Overview / landing — renders the docs README.
  router.get('/home', (c) => {
    const doc = BUNDLED_DOC_BY_SLUG.index;
    if (!doc) return c.notFound();
    return c.html(renderDocPage('index', doc.html, doc.title));
  });

  // Per-doc pages. Slugs are single-segment within each group.
  for (const group of ['guide', 'internals'] as const) {
    router.get(`/${group}/:slug`, (c) => {
      const slug = `${group}/${c.req.param('slug')}`;
      const doc = BUNDLED_DOC_BY_SLUG[slug];
      if (!doc) return c.notFound();
      return c.html(renderDocPage(slug, doc.html, doc.title));
    });
  }

  return router;
}
