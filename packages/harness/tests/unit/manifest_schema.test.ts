import { describe, expect, it } from 'vitest';
// Side-effect imports — populate the pattern registry that validateManifest
// queries for multi-agent semantics. Without these, every pattern looks
// single-agent to the validator and the cross-field rules don't fire.
import '../../src/patterns/deep';
import '../../src/patterns/groupchat';
import '../../src/patterns/parallel';
import '../../src/patterns/react';
import '../../src/patterns/router';
import { ManifestSchema } from '../../src/manifests/schema';
import { ManifestValidationError, validateManifest } from '../../src/manifests/validate';

describe('manifest schema', () => {
  it('rejects an unknown guardrail provider (silent no-op fail-open)', () => {
    // A typo'd/renamed provider would be skipped at runtime, silently
    // disabling filtering while appearing protected. Reject at validation.
    expect(() =>
      ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'g' },
        spec: { pattern: 'react', guardrails: { providers: ['piii'] } },
      }),
    ).toThrow();
    // The known provider still parses.
    expect(() =>
      ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'g' },
        spec: { pattern: 'react', guardrails: { providers: ['pii'] } },
      }),
    ).not.toThrow();
  });

  it('parses the canonical quick manifest', () => {
    const raw = {
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'quick' },
      spec: { pattern: 'react', tools: ['calculator'] },
    };
    const parsed = ManifestSchema.parse(raw);
    expect(parsed.metadata.name).toBe('quick');
    expect(parsed.spec.pattern).toBe('react');
    expect(parsed.spec.tools).toEqual(['calculator']);
  });

  it('rejects unknown fields under strict mode', () => {
    expect(() =>
      ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'x' },
        spec: { pattern: 'react' },
        bogus: true,
      }),
    ).toThrow();
  });

  it('defaults spec.anomaly to the global thresholds', () => {
    const parsed = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'a' },
      spec: { pattern: 'react' },
    });
    expect(parsed.spec.anomaly).toEqual({
      enabled: true,
      min_volume: 10,
      min_rate: 0.2,
      baseline_factor: 3,
    });
  });

  it('accepts a custom spec.anomaly override and rejects out-of-range / unknown keys', () => {
    const parsed = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'a' },
      spec: { pattern: 'react', anomaly: { enabled: false, min_rate: 0.9 } },
    });
    expect(parsed.spec.anomaly.enabled).toBe(false);
    expect(parsed.spec.anomaly.min_rate).toBe(0.9);
    // defaults fill the rest
    expect(parsed.spec.anomaly.min_volume).toBe(10);

    // min_rate > 1 is rejected
    expect(() =>
      ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'a' },
        spec: { pattern: 'react', anomaly: { min_rate: 1.5 } },
      }),
    ).toThrow();

    // unknown key under anomaly is rejected (strict)
    expect(() =>
      ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'a' },
        spec: { pattern: 'react', anomaly: { bogus: 1 } },
      }),
    ).toThrow();
  });

  it('rejects multi-agent pattern with peers', () => {
    const raw = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'r' },
      spec: {
        pattern: 'router',
        sub_agents: ['quick'],
        peers: [{ name: 'p', url: 'https://p' }],
      },
    });
    expect(() => validateManifest(raw)).toThrow(ManifestValidationError);
  });

  it('rejects multi-agent pattern with no sub_agents', () => {
    const raw = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'r' },
      spec: { pattern: 'parallel' },
    });
    expect(() => validateManifest(raw)).toThrow(ManifestValidationError);
  });

  it('forbids aggregator_prompt outside parallel', () => {
    const raw = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'r' },
      spec: { pattern: 'react', aggregator_prompt: 'nope' },
    });
    expect(() => validateManifest(raw)).toThrow(ManifestValidationError);
  });

  it('accepts the legacy agentcore memory alias', () => {
    const parsed = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'q' },
      spec: { memory: { checkpointer: 'agentcore', store: 'agentcore' } },
    });
    expect(parsed.spec.memory.checkpointer).toBe('agentcore');
    expect(parsed.spec.memory.store).toBe('agentcore');
  });

  it('caps recursion_limit at the absolute ceiling', () => {
    expect(() =>
      ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'x' },
        spec: { recursion_limit: 1_000_000 },
      }),
    ).toThrow();
  });

  it('caps max_tool_calls at the absolute ceiling', () => {
    expect(() =>
      ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'x' },
        spec: { limits: { max_tool_calls: 100_000 } },
      }),
    ).toThrow();
  });

  it('rejects loopback mcp server URL (SSRF)', () => {
    expect(() =>
      ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'x' },
        spec: { mcp_servers: [{ name: 'evil', url: 'http://127.0.0.1:8080' }] },
      }),
    ).toThrow();
  });

  it('rejects link-local peer URL (IMDS)', () => {
    expect(() =>
      ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'x' },
        spec: { peers: [{ name: 'imds', url: 'http://169.254.169.254/latest' }] },
      }),
    ).toThrow();
  });

  it('rejects private-suffix host', () => {
    expect(() =>
      ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'x' },
        spec: { peers: [{ name: 'k8s', url: 'https://api.cluster.local/' }] },
      }),
    ).toThrow();
  });
});
