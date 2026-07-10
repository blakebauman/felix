import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Env } from '../../src/env';
import { buildAgent } from '../../src/manifests/builder';
import { ManifestSchema } from '../../src/manifests/schema';
import { InMemoryToolProvider } from '../../src/tools/provider';
import { defineTool } from '../../src/tools/types';

function fakeEnv(): Env {
  return {
    MODEL_ROUTES: JSON.stringify({
      'claude-sonnet-4': { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
    }),
    DEFAULT_MODEL_ID: 'claude-sonnet-4',
    ENVIRONMENT: 'development',
  } as unknown as Env;
}

const echo = defineTool({
  name: 'echo',
  description: 'echo',
  args: z.object({ text: z.string() }),
  handler: async ({ text }) => text,
});

const manifest = ManifestSchema.parse({
  apiVersion: 'orchestrator/v1',
  kind: 'Agent',
  metadata: { name: 'echo-agent', version: '1.0.0' },
  spec: {
    pattern: 'react',
    tools: ['echo'],
    memory: { checkpointer: 'none', store: 'none' },
    limits: { max_tool_calls: 3, max_wall_clock_seconds: null, max_peer_hops: null },
    policies: [
      {
        id: 'echo-policy',
        description: 'requires read scope',
        required_scopes: ['read'],
        tools: ['echo'],
      },
    ],
    guardrails: { providers: ['pii'], block_on_match: false, targets: ['output'] },
    approvals: [],
  },
});

describe('buildAgent', () => {
  it('compiles a react manifest with the full governance pipeline', async () => {
    const provider = new InMemoryToolProvider({ echo: () => echo });
    const agent = await buildAgent(manifest, { env: fakeEnv(), tools: provider });
    expect(agent.pattern).toBe('react');
    expect(agent.manifestId).toBe('echo-agent');
    expect(agent.tools).toHaveLength(1);
    // The wrapper changes identity but preserves name/description.
    expect(agent.tools[0]!.name).toBe('echo');
    expect(agent.tools[0]).not.toBe(echo);
  });

  it('routes deep manifests through deep pattern + plan tools', async () => {
    const deepManifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'deep-agent' },
      spec: {
        pattern: 'deep',
        tools: ['echo'],
        memory: { checkpointer: 'none', store: 'none' },
      },
    });
    const provider = new InMemoryToolProvider({ echo: () => echo });
    const agent = await buildAgent(deepManifest, { env: fakeEnv(), tools: provider });
    expect(agent.pattern).toBe('deep');
    const toolNames = agent.tools.map((t) => t.name).sort();
    expect(toolNames).toContain('plan_create');
    expect(toolNames).toContain('plan_get');
    expect(toolNames).toContain('plan_update_step');
    expect(toolNames).toContain('echo');
  });

  it('rejects an invalid manifest before reaching pattern construction', async () => {
    const bad = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'bad' },
      spec: { pattern: 'parallel' /* missing sub_agents */ },
    });
    const provider = new InMemoryToolProvider();
    await expect(buildAgent(bad, { env: fakeEnv(), tools: provider })).rejects.toThrow();
  });

  it('injects memory tools for vectorize-backed manifests', async () => {
    const mem = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'memo' },
      spec: {
        pattern: 'react',
        tools: ['echo'],
        memory: { checkpointer: 'none', store: 'vectorize' },
      },
    });
    const provider = new InMemoryToolProvider({ echo: () => echo });
    const agent = await buildAgent(mem, { env: fakeEnv(), tools: provider });
    const names = agent.tools.map((t) => t.name);
    expect(names).toContain('memory_remember');
    expect(names).toContain('memory_recall');
  });
});
