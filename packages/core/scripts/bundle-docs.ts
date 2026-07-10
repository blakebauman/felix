/**
 * Bundle the prose docs under `docs/` into a TypeScript module the Worker
 * can import at build time. Workers have no filesystem, so the rendered
 * HTML is baked in at deploy time and served by `src/docs/site.ts`.
 *
 * Mirrors `scripts/bundle-manifests.ts`. Markdown → HTML happens here (not
 * at runtime) so the Worker ships no markdown dependency, and intra-doc
 * `.md` links are rewritten to on-site routes via `src/docs/links.ts`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { type DocGroup, rewriteDocLink, slugFor, titleFrom } from '../src/docs/links';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const repoRoot = resolve(__dirname, '..');
const docsDir = join(repoRoot, 'docs');

interface DocEntry {
  slug: string;
  title: string;
  group: DocGroup;
  html: string;
  order: number;
}

// Narrative order matching docs/README.md. Files not listed sort after, by name.
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
  'commerce',
  'governance',
  'auth',
  'observability',
  'testing',
];

function orderFor(slug: string, group: DocGroup): number {
  if (group === 'root') return -1;
  const list = group === 'guide' ? GUIDE_ORDER : INTERNALS_ORDER;
  const name = slug.split('/').pop() ?? slug;
  const idx = list.indexOf(name);
  return idx === -1 ? list.length + name.charCodeAt(0) : idx;
}

function humanize(name: string): string {
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Render one markdown file to HTML, rewriting links relative to its group. */
function renderMarkdown(markdown: string, group: DocGroup): string {
  const md = new Marked({ gfm: true });
  md.use({
    walkTokens(token) {
      if (token.type === 'link') {
        token.href = rewriteDocLink(token.href, group);
      }
    },
  });
  return md.parse(markdown, { async: false }) as string;
}

function makeEntry(docRelPath: string, group: DocGroup): DocEntry {
  const markdown = readFileSync(join(docsDir, docRelPath), 'utf8');
  const slug = slugFor(docRelPath);
  const fallback = humanize(slug.split('/').pop() ?? slug);
  return {
    slug,
    title: titleFrom(markdown, fallback),
    group,
    html: renderMarkdown(markdown, group),
    order: orderFor(slug, group),
  };
}

function mdFilesIn(subdir: string): string[] {
  const dir = join(docsDir, subdir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => `${subdir}/${e.name}`)
    .sort();
}

const entries: DocEntry[] = [];
if (existsSync(join(docsDir, 'README.md'))) {
  entries.push(makeEntry('README.md', 'root'));
}
for (const f of mdFilesIn('guide')) entries.push(makeEntry(f, 'guide'));
for (const f of mdFilesIn('internals')) entries.push(makeEntry(f, 'internals'));

const out = `// @generated — run \`pnpm build:docs\` to refresh.
// Source: ${docsDir}

export interface DocEntry {
  slug: string;
  title: string;
  group: 'guide' | 'internals' | 'root';
  html: string;
  order: number;
}

export const BUNDLED_DOCS: DocEntry[] = ${JSON.stringify(entries, null, 2)};

export const BUNDLED_DOC_BY_SLUG: Record<string, DocEntry> = Object.fromEntries(
  BUNDLED_DOCS.map((d) => [d.slug, d]),
);
`;

writeFileSync(join(__dirname, '../src/docs/bundled.ts'), out);

console.log(`Bundled ${entries.length} docs.`);
