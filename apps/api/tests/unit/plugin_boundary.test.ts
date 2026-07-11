/**
 * Plugin-boundary enforcement: the harness must be commerce-blind.
 *
 * Felix Commerce lives in its own workspace package (`packages/commerce`,
 * `@felix/commerce`). Since the wiring root moved into this app
 * (`apps/api/src/composition.ts`), the boundary is even stricter than it
 * used to be. Three invariants keep it real:
 *
 *   1. No harness source file (`packages/harness/src`) imports
 *      `@felix/commerce` at all — the harness has zero knowledge of any
 *      plugin — and nothing reaches outside its own src/ with a relative
 *      path.
 *   2. This app imports `@felix/commerce` only from the wiring root
 *      (`src/composition.ts`), and only via the package root import.
 *   3. No file inside `packages/commerce` escapes the package with a
 *      relative import — core seams must be consumed through the
 *      `@felix/harness/*` package specifier, keeping the dependency
 *      explicit and the package relocatable.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = path.resolve(APP_ROOT, '../..');
const APP_SRC = path.join(APP_ROOT, 'src');
const HARNESS = path.join(REPO_ROOT, 'packages', 'harness');
const HARNESS_SRC = path.join(HARNESS, 'src');
const PKG = path.join(REPO_ROOT, 'packages', 'commerce');
const WIRING_ROOT = path.join(APP_SRC, 'composition.ts');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* walk(full);
    } else if (entry.isFile() && full.endsWith('.ts')) yield full;
  }
}

function importSpecs(source: string): string[] {
  return [...source.matchAll(/(?:from|module)\s+'([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('plugin boundary', () => {
  it('the harness never imports @felix/commerce and never escapes its src/', () => {
    const violations: string[] = [];
    for (const file of walk(HARNESS_SRC)) {
      for (const spec of importSpecs(readFileSync(file, 'utf8'))) {
        if (spec === '@felix/commerce' || spec.startsWith('@felix/commerce/')) {
          violations.push(`${path.relative(REPO_ROOT, file)} imports '${spec}'`);
        } else if (spec.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), spec);
          if (!resolved.startsWith(HARNESS_SRC + path.sep)) {
            violations.push(`${path.relative(REPO_ROOT, file)} escapes src/ via '${spec}'`);
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('this app imports @felix/commerce only from the wiring root', () => {
    const violations: string[] = [];
    for (const file of walk(APP_SRC)) {
      for (const spec of importSpecs(readFileSync(file, 'utf8'))) {
        if (spec === '@felix/commerce' || spec.startsWith('@felix/commerce/')) {
          if (file === WIRING_ROOT && spec === '@felix/commerce') continue;
          violations.push(`${path.relative(REPO_ROOT, file)} imports '${spec}'`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('packages/commerce never escapes the package with a relative import', () => {
    const violations: string[] = [];
    for (const file of walk(path.join(PKG, 'src'))) {
      for (const spec of importSpecs(readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(file), spec);
        if (!resolved.startsWith(PKG + path.sep)) {
          violations.push(`${path.relative(REPO_ROOT, file)} escapes the package via '${spec}'`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
