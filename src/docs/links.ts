/**
 * Doc-link rewriting + slug helpers.
 *
 * Pure module (only `node:path/posix`), shared between the build script
 * (`scripts/bundle-docs.ts`) and unit tests. The Worker never imports this
 * at runtime — links are baked into the bundled HTML at build time.
 */

import { posix } from 'node:path';

/** Route base for the on-site prose docs. Slugs map to `${DOCS_BASE}/${slug}`. */
export const DOCS_BASE = '/docs';

/** GitHub blob root for links that escape the `docs/` tree (e.g. `examples/`). */
const REPO_BLOB = 'https://github.com/blakebauman/felix-run/blob/main';

export type DocGroup = 'guide' | 'internals' | 'root';

/** Where a doc of a given group lives relative to the repo's `docs/` root. */
function baseDir(group: DocGroup): string {
  return group === 'root' ? 'docs' : `docs/${group}`;
}

/**
 * Map a `docs/`-relative path (no `.md`, no fragment) to a site route.
 * `docs/README` is the overview index at `${DOCS_BASE}/home`; everything
 * else keeps its `<group>/<name>` shape under `${DOCS_BASE}`.
 */
function docPathToRoute(docRelPath: string): string {
  if (docRelPath === 'README') return `${DOCS_BASE}/home`;
  return `${DOCS_BASE}/${docRelPath}`;
}

/**
 * Rewrite a relative intra-doc markdown href into an on-site route.
 *
 * - Pure `#anchor` and absolute (`http(s):`, `mailto:`, protocol-relative
 *   `//`) links pass through unchanged.
 * - A relative `.md` link that resolves *inside* `docs/` becomes a site
 *   route (`/docs/guide/concepts`, `/docs/internals/persistence`, …),
 *   preserving any `#fragment`.
 * - A relative link that escapes `docs/` (e.g. `../../examples/foo/`) maps
 *   to the GitHub blob URL for that repo path.
 *
 * `fromGroup` is the group of the *source* doc, needed to resolve `../`.
 */
export function rewriteDocLink(href: string, fromGroup: DocGroup): string {
  if (!href) return href;
  // In-page anchor — marked's gfm slugger emits matching ids on headings.
  if (href.startsWith('#')) return href;
  // Absolute / protocol-relative / mailto — leave alone.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href;

  const hashIdx = href.indexOf('#');
  const fragment = hashIdx >= 0 ? href.slice(hashIdx) : '';
  const path = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  if (!path) return href; // was just a fragment (already handled), defensive

  // Resolve against the source doc's directory, virtually rooted at the repo.
  const resolved = posix.normalize(posix.join(baseDir(fromGroup), path));

  // Escaped the docs/ tree (or the repo) → point at GitHub.
  if (resolved.startsWith('..')) return href;
  if (!resolved.startsWith('docs/') && resolved !== 'docs') {
    return `${REPO_BLOB}/${resolved}${fragment}`;
  }

  // Inside docs/. Only `.md` files become site routes; anything else
  // (a directory, an image) is served from GitHub.
  if (!resolved.endsWith('.md')) {
    return `${REPO_BLOB}/${resolved}${fragment}`;
  }
  const docRelPath = resolved.slice('docs/'.length, -'.md'.length);
  return `${docPathToRoute(docRelPath)}${fragment}`;
}

/**
 * Compute the bundle slug for a `docs/`-relative file path.
 * `README.md` → `index`; `guide/concepts.md` → `guide/concepts`.
 */
export function slugFor(docRelPath: string): string {
  const noExt = docRelPath.replace(/\.md$/, '');
  return noExt === 'README' ? 'index' : noExt;
}

/** First-level `# Heading` text, or a humanized fallback from the filename. */
export function titleFrom(markdown: string, fallback: string): string {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m?.[1] ? m[1].trim() : fallback;
}
