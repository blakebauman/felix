/**
 * Manifest `spec.sandboxes[]` — schema parsing + cross-field validation.
 *
 * Pins:
 *   - default is empty array (no behavior change for existing manifests)
 *   - declared sandbox entries parse with sensible defaults
 *   - multi-agent patterns reject `sandboxes` (children own their leaf tools)
 *   - missing required fields throw
 */

import { describe, expect, it } from 'vitest';
import { ManifestSchema } from '../../src/manifests/schema';
import { ManifestValidationError, validateManifest } from '../../src/manifests/validate';
// Side-effect import — registers `parallel` so cross-field validation
// can recognize it as multi-agent.
import '../../src/patterns/parallel';

const base = {
  apiVersion: 'orchestrator/v1',
  kind: 'Agent',
  metadata: { name: 'x', version: '1.0.0' },
  spec: {},
};

describe('manifest spec.sandboxes schema', () => {
  it('defaults to an empty array', () => {
    const parsed = ManifestSchema.parse(base);
    expect(parsed.spec.sandboxes).toEqual([]);
  });

  it('parses a sandbox entry with defaults filled in', () => {
    const parsed = ManifestSchema.parse({
      ...base,
      spec: {
        sandboxes: [
          {
            name: 'py',
            binding: 'SANDBOX',
          },
        ],
      },
    });
    expect(parsed.spec.sandboxes).toEqual([
      {
        name: 'py',
        description: '',
        binding: 'SANDBOX',
        sandbox_tool_name: '',
        timeout_ms: null,
        path_prefix: '',
        args_schema: null,
        fatal: false,
      },
    ]);
  });

  it('rejects an entry missing the binding (Zod strict)', () => {
    expect(() =>
      ManifestSchema.parse({
        ...base,
        spec: { sandboxes: [{ name: 'py' }] },
      }),
    ).toThrow();
  });

  it('rejects unknown keys (Zod strict on SandboxRef)', () => {
    expect(() =>
      ManifestSchema.parse({
        ...base,
        spec: {
          sandboxes: [{ name: 'py', binding: 'SANDBOX', extra_key: 'nope' }],
        },
      }),
    ).toThrow();
  });
});

describe('manifest sandboxes cross-field validation', () => {
  it('passes on a single-agent manifest declaring sandboxes', () => {
    const m = ManifestSchema.parse({
      ...base,
      spec: {
        pattern: 'react',
        sandboxes: [{ name: 'py', binding: 'SANDBOX' }],
      },
    });
    expect(() => validateManifest(m)).not.toThrow();
  });

  it('rejects sandboxes on a multi-agent pattern (parallel)', () => {
    const m = ManifestSchema.parse({
      ...base,
      spec: {
        pattern: 'parallel',
        sub_agents: ['child-a'],
        sandboxes: [{ name: 'py', binding: 'SANDBOX' }],
      },
    });
    expect(() => validateManifest(m)).toThrow(ManifestValidationError);
    expect(() => validateManifest(m)).toThrow(/mutually exclusive with sandboxes/);
  });
});
