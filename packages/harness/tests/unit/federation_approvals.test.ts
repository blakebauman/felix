/**
 * Federation-distributed approvals. `PolicyBundleSchema.approvals` was
 * `z.array(z.unknown())` and `mergeWithManifest` explicitly SKIPPED cross-
 * merging bundle approvals, so a central authority could distribute policies
 * fleet-wide but not approval gates. This pins the tightened behavior:
 *
 *   1. Bundle approvals flow through `mergeWithManifest` into the effective set.
 *   2. Bundle wins on id collision (a manifest can't silently disable a central
 *      approval gate — same semantics as policies).
 *   3. A bundle-contributed rule gates the matching tool via `applyApprovals`
 *      exactly like a manifest rule does.
 *   4. The tightened schema still accepts a well-formed bundle carrying a full
 *      ApprovalRule (with the ttl_seconds / one_shot / bind_principal fields).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApprovalRule } from '../../src/approvals/models';
import { applyApprovals } from '../../src/approvals/wrap';
import { mergeWithManifest, setActiveBundle } from '../../src/policy/bundle';
import { PolicyBundleSchema } from '../../src/policy/models';
import { defineTool } from '../../src/tools/types';

afterEach(() => {
  setActiveBundle(null);
});

describe('mergeWithManifest cross-merges bundle approvals', () => {
  it('adds a bundle-only approval rule to the effective set', () => {
    setActiveBundle(
      PolicyBundleSchema.parse({
        version: 'v1',
        issuer: 'central',
        policies: [],
        approvals: [{ id: 'central-writes', tools: ['delete_everything'] }],
      }),
    );
    const merged = mergeWithManifest([], []);
    expect(merged.approvals.map((a) => a.id)).toContain('central-writes');
    const rule = merged.approvals.find((a) => a.id === 'central-writes');
    expect(rule?.tools).toEqual(['delete_everything']);
  });

  it('bundle wins on id collision with a manifest approval', () => {
    setActiveBundle(
      PolicyBundleSchema.parse({
        version: 'v1',
        issuer: 'central',
        policies: [],
        // Central override: same id, but gates a broader tool set + one-shot.
        approvals: [{ id: 'writes', tools: ['stripe__*'], one_shot: true }],
      }),
    );
    const manifestApprovals = [
      { id: 'writes', tools: ['harmless_tool'], one_shot: false },
    ] as ApprovalRule[];
    const merged = mergeWithManifest([], manifestApprovals);
    const writes = merged.approvals.filter((a) => a.id === 'writes');
    // Exactly one rule for the id — the bundle's, not the manifest's.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.tools).toEqual(['stripe__*']);
    expect(writes[0]?.one_shot).toBe(true);
  });

  it('keeps manifest approvals whose id the bundle does not override', () => {
    setActiveBundle(
      PolicyBundleSchema.parse({
        version: 'v1',
        issuer: 'central',
        policies: [],
        approvals: [{ id: 'central-only', tools: ['a'] }],
      }),
    );
    const manifestApprovals = [{ id: 'manifest-only', tools: ['b'] }] as ApprovalRule[];
    const merged = mergeWithManifest([], manifestApprovals);
    expect(merged.approvals.map((a) => a.id).sort()).toEqual(['central-only', 'manifest-only']);
  });
});

describe('a bundle-contributed approval rule gates a tool after merge', () => {
  it('wraps the matching tool just like a manifest rule', () => {
    setActiveBundle(
      PolicyBundleSchema.parse({
        version: 'v1',
        issuer: 'central',
        policies: [],
        approvals: [{ id: 'central-writes', tools: ['delete_everything'] }],
      }),
    );
    const merged = mergeWithManifest([], []);

    const gated = defineTool({
      name: 'delete_everything',
      description: 'irreversible',
      args: z.object({ target: z.string() }),
      async handler({ target }) {
        return `deleted ${target}`;
      },
    });
    const untouched = defineTool({
      name: 'read_thing',
      description: 'safe',
      args: z.object({ x: z.string() }),
      async handler() {
        return 'ok';
      },
    });

    const [wrappedGated, wrappedUntouched] = applyApprovals(
      [gated, untouched],
      merged.approvals,
      'm',
    );
    expect(wrappedGated).not.toBe(gated); // gated by the bundle rule
    expect(wrappedUntouched).toBe(untouched); // not matched — passes through
  });
});

describe('tightened PolicyBundleSchema.approvals', () => {
  it('accepts a full ApprovalRule with ttl_seconds / one_shot / bind_principal', () => {
    const parsed = PolicyBundleSchema.parse({
      version: 'v1',
      issuer: 'central',
      policies: [],
      approvals: [
        {
          id: 'prod-writes',
          description: 'central gate',
          tools: ['prod__*'],
          ttl_seconds: 3600,
          one_shot: true,
          bind_principal: true,
        },
      ],
    });
    expect(parsed.approvals[0]?.ttl_seconds).toBe(3600);
    expect(parsed.approvals[0]?.one_shot).toBe(true);
    expect(parsed.approvals[0]?.bind_principal).toBe(true);
  });

  it('rejects an approval rule with an unknown key (.strict())', () => {
    expect(() =>
      PolicyBundleSchema.parse({
        version: 'v1',
        issuer: 'central',
        policies: [],
        approvals: [{ id: 'x', tools: ['a'], bogus_field: true }],
      }),
    ).toThrow();
  });
});
