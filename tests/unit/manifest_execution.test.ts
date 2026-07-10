/**
 * Manifest `spec.execution` field — schema parsing + validation.
 *
 * Pins the Phase-3 contract that toggles durable execution:
 *   - default is `transient` (no behavior change for existing manifests)
 *   - `durable` requires a single-agent pattern (cross-field rule)
 *   - `durable` requires a checkpointed memory (resume needs a session log)
 */

import { describe, expect, it } from 'vitest';
import { ManifestSchema } from '../../src/manifests/schema';
import { ManifestValidationError, validateManifest } from '../../src/manifests/validate';
// Side-effect import — registers the `parallel` pattern in the registry
// so cross-field validation can recognize it as multi-agent.
import '../../src/patterns/parallel';

const base = {
  apiVersion: 'orchestrator/v1',
  kind: 'Agent',
  metadata: { name: 'x', version: '1.0.0' },
  spec: {},
};

describe('manifest spec.execution schema', () => {
  it("defaults to mode='transient' when execution is omitted", () => {
    const parsed = ManifestSchema.parse(base);
    expect(parsed.spec.execution).toEqual({ mode: 'transient', resume_token_ttl_seconds: null });
  });

  it('accepts mode=durable and an explicit resume TTL', () => {
    const parsed = ManifestSchema.parse({
      ...base,
      spec: { execution: { mode: 'durable', resume_token_ttl_seconds: 86400 } },
    });
    expect(parsed.spec.execution.mode).toBe('durable');
    expect(parsed.spec.execution.resume_token_ttl_seconds).toBe(86400);
  });

  it('rejects unknown execution modes (strict object)', () => {
    expect(() =>
      ManifestSchema.parse({
        ...base,
        spec: { execution: { mode: 'eventual' } },
      }),
    ).toThrow();
  });
});

describe('manifest execution cross-field validation', () => {
  function makeManifest(specOverrides: Record<string, unknown>) {
    return ManifestSchema.parse({
      ...base,
      spec: specOverrides,
    });
  }

  it('passes a transient manifest with any pattern', () => {
    expect(() => validateManifest(makeManifest({ pattern: 'react' }))).not.toThrow();
  });

  it('passes a durable react manifest with a checkpointed memory', () => {
    const m = makeManifest({
      pattern: 'react',
      execution: { mode: 'durable', resume_token_ttl_seconds: null },
      memory: { checkpointer: 'do', store: 'none' },
    });
    expect(() => validateManifest(m)).not.toThrow();
  });

  it('rejects durable + parallel (multi-agent pattern)', () => {
    const m = makeManifest({
      pattern: 'parallel',
      sub_agents: ['child-a', 'child-b'],
      execution: { mode: 'durable', resume_token_ttl_seconds: null },
    });
    expect(() => validateManifest(m)).toThrow(ManifestValidationError);
    expect(() => validateManifest(m)).toThrow(/single-agent patterns/);
  });

  it("rejects durable + memory.checkpointer='none'", () => {
    const m = makeManifest({
      pattern: 'react',
      execution: { mode: 'durable', resume_token_ttl_seconds: null },
      memory: { checkpointer: 'none', store: 'none' },
    });
    expect(() => validateManifest(m)).toThrow(ManifestValidationError);
    expect(() => validateManifest(m)).toThrow(/checkpointed memory/);
  });
});
