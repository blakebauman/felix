/**
 * Plugin-boundary enforcement: core must be commerce-blind.
 *
 * Felix Commerce lives in its own workspace package (`packages/commerce`,
 * published to the app as `@felix/commerce`). The ONLY core file allowed to
 * reference it is `src/composition.ts` (the wiring root), and only via the
 * package root import. Two invariants keep the boundary real:
 *
 *   1. No core source file imports `@felix/commerce` (any subpath) except
 *      the wiring root's single root-import — and nothing reaches into
 *      `packages/` with a relative path.
 *   2. No file inside `packages/commerce` escapes the package with a
 *      relative import — core seams must be consumed through the
 *      `@felix/orchestrator/*` package specifier, keeping the dependency
 *      explicit and the package relocatable.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src');
const PKG = path.join(ROOT, 'packages', 'commerce');
const WIRING_ROOT = path.join(SRC, 'composition.ts');

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
  it('core imports @felix/commerce only from the wiring root, and never reaches into packages/', () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      for (const spec of importSpecs(readFileSync(file, 'utf8'))) {
        if (spec === '@felix/commerce' || spec.startsWith('@felix/commerce/')) {
          if (file === WIRING_ROOT && spec === '@felix/commerce') continue;
          violations.push(`${path.relative(ROOT, file)} imports '${spec}'`);
        } else if (spec.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), spec);
          if (!resolved.startsWith(SRC + path.sep)) {
            violations.push(`${path.relative(ROOT, file)} escapes src/ via '${spec}'`);
          }
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
          violations.push(`${path.relative(ROOT, file)} escapes the package via '${spec}'`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
