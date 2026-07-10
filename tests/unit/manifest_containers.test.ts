/**
 * Containers as a manifest-declared transport.
 *
 * Pins the deployment surface for `ContainerExecutor`:
 *
 *   1. A `containers: [...]` entry in a manifest builds a `Tool` whose
 *      executor reports `transport: 'container'`.
 *   2. The schema rejects malformed entries (missing image, bad URL).
 *   3. The schema is mutually exclusive with multi-agent patterns —
 *      `router` / `parallel` / `groupchat` reject `containers=[...]` the
 *      same way they reject `peers=[...]`.
 *   4. Governance wrappers (limits) preserve the inner `container`
 *      transport label after wrapping, so audit + counters stay
 *      transport-accurate end-to-end.
 *   5. The container tool is dispatchable through the agent (transport
 *      label survives all the way to `agent.tools[i].executor.transport`).
 */

import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { buildAgent } from '../../src/manifests/builder';
import { ManifestSchema } from '../../src/manifests/schema';
import { InMemoryToolProvider } from '../../src/tools/provider';

function fakeEnv(): Env {
  return {
    MODEL_ROUTES: JSON.stringify({
      'claude-sonnet-4': { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
    }),
    DEFAULT_MODEL_ID: 'claude-sonnet-4',
    ENVIRONMENT: 'development',
  } as unknown as Env;
}

describe('manifest containers', () => {
  it('builds a Tool from a containers[] entry with transport=container', async () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'sandboxed' },
      spec: {
        pattern: 'react',
        memory: { checkpointer: 'none', store: 'none' },
        containers: [
          {
            name: 'python_runner',
            description: 'run python in a sandbox',
            gateway_url: 'https://container.example.com/run',
            image: 'py-sandbox:1',
          },
        ],
      },
    });
    const agent = await buildAgent(manifest, {
      env: fakeEnv(),
      tools: new InMemoryToolProvider(),
    });
    const tool = agent.tools.find((t) => t.name === 'python_runner');
    expect(tool, 'python_runner not found in agent.tools').toBeDefined();
    expect(tool!.executor.transport).toBe('container');
    expect(tool!.source).toBe('container:py-sandbox:1');
  });

  it('advertises rawInputSchema verbatim when args_schema is set', async () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'sandboxed' },
      spec: {
        pattern: 'react',
        memory: { checkpointer: 'none', store: 'none' },
        containers: [
          {
            name: 'sandbox',
            gateway_url: 'https://container.example.com/run',
            image: 'img:1',
            args_schema: {
              type: 'object',
              properties: { code: { type: 'string' } },
              required: ['code'],
            },
          },
        ],
      },
    });
    const agent = await buildAgent(manifest, {
      env: fakeEnv(),
      tools: new InMemoryToolProvider(),
    });
    const tool = agent.tools.find((t) => t.name === 'sandbox')!;
    expect(tool.rawInputSchema).toEqual({
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    });
  });

  it('schema rejects an entry missing the image field', () => {
    expect(() =>
      ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'bad' },
        spec: {
          pattern: 'react',
          containers: [{ name: 'x', gateway_url: 'https://container.example.com/run' }],
        },
      }),
    ).toThrow();
  });

  it('schema rejects an http:// gateway URL (SSRF guard)', () => {
    expect(() =>
      ManifestSchema.parse({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'bad' },
        spec: {
          pattern: 'react',
          containers: [
            { name: 'x', gateway_url: 'http://container.example.com/run', image: 'i:1' },
          ],
        },
      }),
    ).toThrow();
  });

  it('forbids containers on multi-agent patterns (router)', async () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'bad' },
      spec: {
        pattern: 'router',
        sub_agents: ['child'],
        memory: { checkpointer: 'none', store: 'none' },
        containers: [{ name: 'x', gateway_url: 'https://container.example.com/run', image: 'i:1' }],
      },
    });
    await expect(
      buildAgent(manifest, { env: fakeEnv(), tools: new InMemoryToolProvider() }),
    ).rejects.toThrow(/containers/);
  });

  it('preserves the container transport label through the limits wrapper', async () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'wrapped' },
      spec: {
        pattern: 'react',
        memory: { checkpointer: 'none', store: 'none' },
        limits: { max_tool_calls: 3 },
        containers: [
          {
            name: 'sandbox',
            gateway_url: 'https://container.example.com/run',
            image: 'img:1',
          },
        ],
      },
    });
    const agent = await buildAgent(manifest, {
      env: fakeEnv(),
      tools: new InMemoryToolProvider(),
    });
    const tool = agent.tools.find((t) => t.name === 'sandbox')!;
    // Identity must have changed (the limits wrapper replaced the executor)
    // but `transport` must still report `container`, not `local` — that's
    // the guarantee `wrapExecutor` exists to provide.
    expect(tool.executor.transport).toBe('container');
  });
});
