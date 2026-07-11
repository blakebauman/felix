/**
 * Sync the per-package docs sources into Starlight's content directory.
 *
 * Docs markdown stays co-located with the package it documents
 * (`packages/harness/docs/`, `packages/commerce/docs/`); this script aggregates
 * them into `src/content/docs/` (gitignored) before every dev/build:
 *
 * - injects Starlight frontmatter (`title` from the first `# H1`, which is
 *   stripped from the body; `sidebar.order` from the narrative order lists)
 * - rewrites relative markdown links: links that resolve to another synced
 *   doc become site routes; links that escape the docs trees become GitHub
 *   blob URLs. Code fences are left untouched.
 *
 * Sources use GitHub-valid relative paths (e.g. a core doc references the
 * commerce doc as `../../../commerce/docs/index.md`), so the markdown stays
 * browsable in the repo and the route mapping happens only here.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { starlightThemeCss } from '@felix/design/tokens';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '../..');
const outDir = join(pkgRoot, 'src', 'content', 'docs');

/** GitHub blob root for links that escape the synced docs trees. */
const REPO_BLOB = 'https://github.com/blakebauman/felix-run/blob/main';

// Narrative sidebar order (matches the reading order in the core README).
const GUIDE_ORDER = [
  'getting-started',
  'concepts',
  'manifest-reference',
  'rest-api',
  'management-api',
  'deploy',
];
const INTERNALS_ORDER = [
  'architecture',
  'manifest-pipeline',
  'patterns',
  'model-client',
  'persistence',
  'governance',
  'auth',
  'observability',
  'testing',
];

interface DocSource {
  /** Repo-relative source path, e.g. `packages/harness/docs/guide/concepts.md`. */
  repoPath: string;
  /** Output slug under src/content/docs (no extension), e.g. `guide/concepts`. */
  slug: string;
  /** `sidebar.order` frontmatter, when the group has a narrative order. */
  order?: number;
}

function mdFilesIn(repoDir: string): string[] {
  const abs = join(repoRoot, repoDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
}

function orderIn(list: string[], name: string): number | undefined {
  const idx = list.indexOf(name);
  return idx === -1 ? undefined : idx + 1;
}

function collectSources(): DocSource[] {
  const sources: DocSource[] = [];
  if (existsSync(join(repoRoot, 'packages/harness/docs/README.md'))) {
    sources.push({ repoPath: 'packages/harness/docs/README.md', slug: 'index' });
  }
  for (const group of ['guide', 'internals'] as const) {
    const orderList = group === 'guide' ? GUIDE_ORDER : INTERNALS_ORDER;
    for (const name of mdFilesIn(`packages/harness/docs/${group}`)) {
      const base = name.replace(/\.md$/, '');
      sources.push({
        repoPath: `packages/harness/docs/${group}/${name}`,
        slug: `${group}/${base}`,
        order: orderIn(orderList, base),
      });
    }
  }
  for (const name of mdFilesIn('packages/commerce/docs')) {
    const base = name.replace(/\.md$/, '');
    sources.push({
      repoPath: `packages/commerce/docs/${name}`,
      slug: `commerce/${base}`,
      // The section landing page (index) sorts first; the rest alphabetical.
      order: base === 'index' ? 1 : undefined,
    });
  }
  return sources;
}

/** Site route for a synced slug: `index` → `/`, `commerce/index` → `/commerce/`. */
function routeFor(slug: string): string {
  if (slug === 'index') return '/';
  if (slug.endsWith('/index')) return `/${slug.slice(0, -'/index'.length)}/`;
  return `/${slug}/`;
}

/**
 * Rewrite one markdown href found in a doc at `fromRepoDir`.
 * Anchors, absolute URLs, and site-absolute paths pass through.
 */
function rewriteHref(href: string, fromRepoDir: string, routes: Map<string, string>): string {
  if (!href || href.startsWith('#') || href.startsWith('/')) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href;

  const hashIdx = href.indexOf('#');
  const fragment = hashIdx >= 0 ? href.slice(hashIdx) : '';
  const path = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  if (!path) return href;

  const resolved = posix.normalize(posix.join(fromRepoDir, path));
  if (resolved.startsWith('..')) return href; // escaped the repo — leave alone
  const route = routes.get(resolved);
  if (route) return `${route}${fragment}`;
  return `${REPO_BLOB}/${resolved}${fragment}`;
}

/** Rewrite inline markdown links outside fenced code blocks. */
function rewriteLinks(markdown: string, fromRepoDir: string, routes: Map<string, string>): string {
  const lines = markdown.split('\n');
  let inFence = false;
  const out = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line.replace(
      /\]\(([^()\s]+)\)/g,
      (_m, href: string) => `](${rewriteHref(href, fromRepoDir, routes)})`,
    );
  });
  return out.join('\n');
}

/** Extract the first `# H1` as the title and strip that line from the body. */
function splitTitle(markdown: string, fallback: string): { title: string; body: string } {
  const m = markdown.match(/^#\s+(.+)$/m);
  if (!m) return { title: fallback, body: markdown };
  const body = markdown.replace(m[0], '').replace(/^\s*\n/, '');
  return { title: m[1].trim(), body };
}

function humanize(name: string): string {
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const sources = collectSources();
const routes = new Map(sources.map((s) => [s.repoPath, routeFor(s.slug)]));

rmSync(outDir, { recursive: true, force: true });
for (const src of sources) {
  const raw = readFileSync(join(repoRoot, src.repoPath), 'utf8');
  const fallback = humanize(src.slug.split('/').pop() ?? src.slug);
  const { title, body } = splitTitle(raw, fallback);
  const rewritten = rewriteLinks(body, posix.dirname(src.repoPath), routes);

  const fm = [`title: ${JSON.stringify(title)}`];
  if (src.order !== undefined) fm.push('sidebar:', `  order: ${src.order}`);
  const outPath = join(outDir, `${src.slug}.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `---\n${fm.join('\n')}\n---\n\n${rewritten}`);
}

// Shared design system: render the @felix/design palette (the same module
// the core Worker's Scalar reference themes itself from) into Starlight's
// custom stylesheet, so the API reference and this site stay visually in sync.
const stylesDir = join(pkgRoot, 'src', 'styles');
mkdirSync(stylesDir, { recursive: true });
writeFileSync(join(stylesDir, 'theme.css'), starlightThemeCss());

console.log(`Synced ${sources.length} docs into src/content/docs/ (+ theme.css).`);
