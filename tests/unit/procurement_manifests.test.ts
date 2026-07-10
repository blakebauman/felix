/**
 * Procurement multi-agent wiring: the router + sub-agent manifests validate,
 * and every tool the sub-agents declare is actually registered by `compose`.
 * (The router's LLM dispatch isn't invoked — no live model in unit tests.)
 */

import { describe, expect, it } from 'vitest';
import { compose } from '../../src/composition';
import type { Env } from '../../src/env';
// Side-effect import: registers the built-in patterns (router/parallel/…) so
// validateManifest's multi-agent checks see them.
import '../../src/manifests/builder';
import { loadManifest } from '../../src/manifests/loader';
import { validateManifest } from '../../src/manifests/validate';

const provider = compose({} as Env);

describe('procurement router manifest', () => {
  it('is a valid multi-agent router over the three specialists', () => {
    const m = loadManifest('procurement');
    expect(() => validateManifest(m)).not.toThrow();
    expect(m.spec.pattern).toBe('router');
    expect(m.spec.sub_agents).toEqual([
      'procurement-catalog',
      'procurement-quoting',
      'procurement-billing',
    ]);
  });
});

describe('procurement sub-agents', () => {
  for (const name of ['procurement-catalog', 'procurement-quoting', 'procurement-billing']) {
    it(`${name} validates and all its tools are registered`, () => {
      const m = loadManifest(name);
      expect(() => validateManifest(m)).not.toThrow();
      for (const tool of m.spec.tools) {
        expect(provider.has(tool)).toBe(true);
      }
    });
  }

  it('exposes the quote-to-cash tools to the quoting agent', () => {
    const tools = loadManifest('procurement-quoting').spec.tools;
    for (const t of [
      'create_quote',
      'send_quote',
      'accept_quote',
      'convert_quote',
      'purchase_authority_check',
    ]) {
      expect(tools).toContain(t);
      expect(provider.has(t)).toBe(true);
    }
  });

  it('gates the irreversible convert step behind an approval', () => {
    const m = loadManifest('procurement-quoting');
    expect(m.spec.approvals.some((a) => a.tools.includes('convert_quote'))).toBe(true);
  });
});
