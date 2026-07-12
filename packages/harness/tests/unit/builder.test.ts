import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { buildAgent } from '../../src/manifests/builder';
import { ManifestSchema } from '../../src/manifests/schema';
import * as reactModule from '../../src/patterns/react';
import { InMemoryToolProvider } from '../../src/tools/provider';
import { defineTool, type ToolOutput } from '../../src/tools/types';

function content(out: ToolOutput): string {
  return typeof out === 'string' ? out : out.content;
}

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

  it('runs injected plan tools through the governance pipeline for deep manifests', async () => {
    // A policy targeting `plan_create` must gate it — proving PLAN_TOOLS are
    // injected BEFORE the governance pipeline and not smuggled in ungoverned
    // by the deep adapter (the historic bypass this fix closes).
    const deepManifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'deep-governed' },
      spec: {
        pattern: 'deep',
        tools: ['echo'],
        memory: { checkpointer: 'none', store: 'none' },
        policies: [
          {
            id: 'plan-policy',
            description: 'plan_create requires write scope',
            required_scopes: ['plans:write'],
            tools: ['plan_create'],
          },
        ],
      },
    });
    const provider = new InMemoryToolProvider({ echo: () => echo });
    const agent = await buildAgent(deepManifest, { env: fakeEnv(), tools: provider });
    const planCreate = agent.tools.find((t) => t.name === 'plan_create');
    expect(planCreate).toBeDefined();
    // The governance wrapper changed identity — the raw PLAN_TOOLS export
    // would pass through unguarded.
    await runWithContext(
      { env: fakeEnv(), auth: ANONYMOUS, limitState: newLimitState() },
      async () => {
        const out = await planCreate!.executor.execute({ title: 't', steps: ['a'] });
        expect(content(out)).toContain('[policy denied]');
      },
    );
  });

  it('counts injected plan tools against max_tool_calls for deep manifests', async () => {
    const deepManifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'deep-limited' },
      spec: {
        pattern: 'deep',
        tools: ['echo'],
        memory: { checkpointer: 'none', store: 'none' },
        limits: { max_tool_calls: 1, max_wall_clock_seconds: null, max_peer_hops: null },
      },
    });
    const provider = new InMemoryToolProvider({ echo: () => echo });
    const agent = await buildAgent(deepManifest, { env: fakeEnv(), tools: provider });
    const planCreate = agent.tools.find((t) => t.name === 'plan_create')!;
    const planGet = agent.tools.find((t) => t.name === 'plan_get')!;
    const ctx: RequestContext = {
      env: fakeEnv(),
      auth: ANONYMOUS,
      limitState: newLimitState(),
    };
    await runWithContext(ctx, async () => {
      // First call consumes the single allowed tool call. The limits wrapper
      // ticks `toolCalls` BEFORE delegating, so even though the handler throws
      // against the store-less fakeEnv the budget is still spent.
      try {
        await planCreate.executor.execute({ title: 't', steps: ['a'] });
      } catch {
        // expected — no D1 binding in the unit-test env.
      }
      // The plan tools share the same limits budget as every other tool: the
      // wrapper denies before ever reaching the (throwing) inner handler.
      const blocked = await planGet.executor.execute({ plan_id: 'x' });
      expect(content(blocked)).toContain('[limit exceeded] max_tool_calls');
    });
  });

  it('forwards tools_retrieval and artifacts into the inner react loop for deep', async () => {
    const spy = vi.spyOn(reactModule, 'buildReactAgent');
    try {
      const deepManifest = ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'deep-retrieval' },
        spec: {
          pattern: 'deep',
          tools: ['echo'],
          memory: { checkpointer: 'none', store: 'none' },
          tools_retrieval: { enabled: true },
          artifacts: { enabled: true },
        },
      });
      const provider = new InMemoryToolProvider({ echo: () => echo });
      await buildAgent(deepManifest, { env: fakeEnv(), tools: provider });
      const opts = spy.mock.calls.at(-1)?.[0];
      expect(opts?.toolsRetrieval?.enabled).toBe(true);
      expect(opts?.artifacts?.enabled).toBe(true);
    } finally {
      spy.mockRestore();
    }
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
