/**
 * Queues as a manifest-declared async transport. Pins:
 *
 *   1. A `queues: [...]` entry resolves to a `Tool` whose executor reports
 *      `transport: 'queue'`.
 *   2. The schema rejects malformed entries (missing queue_binding).
 *   3. The build fails loudly when the named binding isn't on env — a
 *      typo'd binding must never silently no-op at request time.
 *   4. Multi-agent patterns reject `queues=[...]` the same way they reject
 *      peers and containers.
 *   5. `args_schema` survives to `rawInputSchema` so the model sees the
 *      contract the manifest author intended.
 *   6. The governance pipeline preserves the `queue` transport label after
 *      wrapping (the same wrapExecutor invariant containers / mcp / a2a
 *      depend on).
 */

import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { buildAgent } from '../../src/manifests/builder';
import { ManifestSchema } from '../../src/manifests/schema';
import { InMemoryToolProvider } from '../../src/tools/provider';

function fakeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    MODEL_ROUTES: JSON.stringify({
      'claude-sonnet-4': { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
    }),
    DEFAULT_MODEL_ID: 'claude-sonnet-4',
    ENVIRONMENT: 'development',
    ...extra,
  } as unknown as Env;
}

function fakeQueue(): Queue {
  return { async send() {}, async sendBatch() {} } as unknown as Queue;
}

describe('manifest queues', () => {
  it('builds a Tool from a queues[] entry with transport=queue', async () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'researcher' },
      spec: {
        pattern: 'react',
        memory: { checkpointer: 'none', store: 'none' },
        queues: [
          {
            name: 'long_research',
            description: 'kick off a long research job',
            queue_binding: 'JOBS_QUEUE',
          },
        ],
      },
    });
    const agent = await buildAgent(manifest, {
      env: fakeEnv({ JOBS_QUEUE: fakeQueue() }),
      tools: new InMemoryToolProvider(),
    });
    const tool = agent.tools.find((t) => t.name === 'long_research');
    expect(tool, 'long_research not found in agent.tools').toBeDefined();
    expect(tool!.executor.transport).toBe('queue');
    expect(tool!.source).toBe('queue:long_research');
  });

  it('advertises rawInputSchema verbatim when args_schema is set', async () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'researcher' },
      spec: {
        pattern: 'react',
        memory: { checkpointer: 'none', store: 'none' },
        queues: [
          {
            name: 'long_research',
            queue_binding: 'JOBS_QUEUE',
            args_schema: {
              type: 'object',
              properties: { topic: { type: 'string' } },
              required: ['topic'],
            },
          },
        ],
      },
    });
    const agent = await buildAgent(manifest, {
      env: fakeEnv({ JOBS_QUEUE: fakeQueue() }),
      tools: new InMemoryToolProvider(),
    });
    const tool = agent.tools.find((t) => t.name === 'long_research')!;
    expect(tool.rawInputSchema).toEqual({
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
    });
  });

  it('schema rejects an entry missing queue_binding', () => {
    expect(() =>
      ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'bad' },
        spec: {
          pattern: 'react',
          queues: [{ name: 'long_research' }],
        },
      }),
    ).toThrow();
  });

  it('build fails loudly when the named binding is not on env', async () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'researcher' },
      spec: {
        pattern: 'react',
        memory: { checkpointer: 'none', store: 'none' },
        queues: [{ name: 'long_research', queue_binding: 'JOBS_QUEUE' }],
      },
    });
    // env intentionally missing the JOBS_QUEUE binding
    await expect(
      buildAgent(manifest, { env: fakeEnv(), tools: new InMemoryToolProvider() }),
    ).rejects.toThrow(/JOBS_QUEUE/);
  });

  it('forbids queues on multi-agent patterns (router)', async () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'bad' },
      spec: {
        pattern: 'router',
        sub_agents: ['child'],
        memory: { checkpointer: 'none', store: 'none' },
        queues: [{ name: 'long_research', queue_binding: 'JOBS_QUEUE' }],
      },
    });
    await expect(
      buildAgent(manifest, {
        env: fakeEnv({ JOBS_QUEUE: fakeQueue() }),
        tools: new InMemoryToolProvider(),
      }),
    ).rejects.toThrow(/queues/);
  });

  it('preserves the queue transport label through the limits wrapper', async () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'wrapped' },
      spec: {
        pattern: 'react',
        memory: { checkpointer: 'none', store: 'none' },
        limits: { max_tool_calls: 3 },
        queues: [{ name: 'long_research', queue_binding: 'JOBS_QUEUE' }],
      },
    });
    const agent = await buildAgent(manifest, {
      env: fakeEnv({ JOBS_QUEUE: fakeQueue() }),
      tools: new InMemoryToolProvider(),
    });
    const tool = agent.tools.find((t) => t.name === 'long_research')!;
    expect(tool.executor.transport).toBe('queue');
  });
});
