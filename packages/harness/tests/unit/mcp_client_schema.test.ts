import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import type { McpServerRef } from '../../src/manifests/schema';
import { bindExternalMcp } from '../../src/mcp/client';
import { getToolInputSchema } from '../../src/patterns/zod-to-json-schema';

function ref(name: string): McpServerRef {
  return { name, url: 'https://mcp.example.com/rpc', auth: '', transport: 'http' };
}

function fakeEnv(): Env {
  return { ENVIRONMENT: 'production' } as Env;
}

function mockToolsList(tools: unknown[]) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { tools } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

describe('bindExternalMcp — remote inputSchema handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards a well-formed remote inputSchema as rawInputSchema', async () => {
    vi.stubGlobal(
      'fetch',
      mockToolsList([
        {
          name: 'search',
          description: 'Search the docs',
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      ]),
    );
    const tools = await bindExternalMcp(ref('stripe'), fakeEnv());
    const tool = tools[0];
    if (!tool) throw new Error('expected one tool from bindExternalMcp');
    expect(tool.name).toBe('stripe__search');
    expect(tool.rawInputSchema).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
    expect(getToolInputSchema(tool)).toBe(tool.rawInputSchema);
  });

  it('caps an oversized remote tool description (injection blast radius)', async () => {
    const huge = 'A'.repeat(20_000);
    vi.stubGlobal('fetch', mockToolsList([{ name: 'evil', description: huge }]));
    const tools = await bindExternalMcp(ref('srv'), fakeEnv());
    const desc = tools[0]!.description;
    expect(desc.length).toBeLessThan(huge.length);
    expect(desc).toMatch(/truncated/);
  });

  it('drops an oversized remote inputSchema', async () => {
    const bigSchema = {
      type: 'object',
      properties: { blob: { type: 'string', description: 'X'.repeat(40_000) } },
    };
    vi.stubGlobal(
      'fetch',
      mockToolsList([{ name: 'big', description: 'ok', inputSchema: bigSchema }]),
    );
    const tools = await bindExternalMcp(ref('srv'), fakeEnv());
    expect(tools[0]!.rawInputSchema).toBeUndefined();
  });

  it('drops a malformed inputSchema and falls back to the Zod compile path', async () => {
    vi.stubGlobal(
      'fetch',
      mockToolsList([
        { name: 'bad-string', inputSchema: 'not-an-object' },
        { name: 'bad-null', inputSchema: null },
        { name: 'wrong-type', inputSchema: { type: 'array' } },
        { name: 'missing' },
      ]),
    );
    const tools = await bindExternalMcp(ref('srv'), fakeEnv());
    for (const t of tools) {
      expect(t.rawInputSchema).toBeUndefined();
      // Falls back to compiling `args` (z.record), which produces an object schema.
      const advertised = getToolInputSchema(t);
      expect(advertised).toBeTypeOf('object');
    }
  });
});
