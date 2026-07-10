/**
 * Plugin-boundary enforcement: core must be commerce-blind.
 *
 * The commerce feature (src/commerce/, src/entities/, src/geo/) plugs into
 * the harness exclusively through the FelixPlugin seam — the ONLY core file
 * allowed to reference it is `src/composition.ts` (the wiring root), and only
 * via the single `./commerce/plugin` import. This test walks every source
 * file outside the plugin dirs and fails on any other import that resolves
 * into them, so the boundary stays enforced rather than aspirational.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const PLUGIN_DIRS = ['commerce', 'entities', 'geo'].map((d) => path.join(SRC, d) + path.sep);
const WIRING_ROOT = path.join(SRC, 'composition.ts');
const ALLOWED_WIRING_IMPORTS = new Set(['./commerce/plugin']);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && full.endsWith('.ts')) yield full;
  }
}

function isInPluginDirs(file: string): boolean {
  return PLUGIN_DIRS.some((d) => file.startsWith(d));
}

describe('plugin boundary', () => {
  it('core never imports from src/commerce, src/entities, or src/geo (except the wiring root)', () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      if (isInPluginDirs(file)) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const spec = match[1] ?? '';
        if (!spec.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(file), spec);
        if (!isInPluginDirs(`${resolved}${path.sep}`) && !isInPluginDirs(resolved)) continue;
        if (file === WIRING_ROOT && ALLOWED_WIRING_IMPORTS.has(spec)) continue;
        violations.push(`${path.relative(SRC, file)} imports '${spec}'`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
