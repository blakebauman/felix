/**
 * Bundle YAML manifests under <repo>/manifests/ into a TypeScript module the
 * Worker can import at build time. Workers have no filesystem; runtime
 * overrides may come from R2 or KV (see manifests/loader.ts), but the
 * default source-of-truth is bundled at deploy time so a fresh deploy
 * cannot start with a missing manifest.
 *
 * Sources are local to this repo (`manifests/`, `skills/`) — the orchestrator
 * owns its own manifest definitions and does not read from any sibling repo.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const repoRoot = resolve(__dirname, '..');
const manifestsDir = join(repoRoot, 'manifests');
const skillsDir = join(repoRoot, 'skills');

function bundleDir(dir: string, kind: 'manifest' | 'skill'): Record<string, unknown> {
  if (!existsSync(dir)) return {};
  const out: Record<string, unknown> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (kind === 'manifest' && entry.isFile() && entry.name.endsWith('.yaml')) {
      const raw = readFileSync(join(dir, entry.name), 'utf8');
      const parsed = parseYaml(raw) as { metadata?: { name?: string } };
      const name = parsed?.metadata?.name ?? entry.name.replace(/\.yaml$/, '');
      out[name] = parsed;
    } else if (kind === 'skill' && entry.isDirectory()) {
      const skillFile = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      out[entry.name] = readFileSync(skillFile, 'utf8');
    }
  }
  return out;
}

const manifests = bundleDir(manifestsDir, 'manifest');
const skills = bundleDir(skillsDir, 'skill');

const manifestOut = `// @generated — run \`pnpm build:manifests\` to refresh.
// Source: ${manifestsDir}

export const BUNDLED_MANIFESTS: Record<string, unknown> = ${JSON.stringify(manifests, null, 2)};

export const BUNDLED_MANIFEST_NAMES = Object.freeze(Object.keys(BUNDLED_MANIFESTS));
`;

const skillOut = `// @generated — run \`pnpm build:manifests\` to refresh.
// Source: ${skillsDir}

export const BUNDLED_SKILLS: Record<string, string> = ${JSON.stringify(skills, null, 2)};

export const BUNDLED_SKILL_NAMES = Object.freeze(Object.keys(BUNDLED_SKILLS));
`;

writeFileSync(join(__dirname, '../src/manifests/bundled.ts'), manifestOut);
writeFileSync(join(__dirname, '../src/skills/bundled.ts'), skillOut);

console.log(`Bundled ${Object.keys(manifests).length} manifests, ${Object.keys(skills).length} skills.`);
