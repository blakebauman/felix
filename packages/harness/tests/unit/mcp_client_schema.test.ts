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

  it('refuses to follow a redirect from the MCP server (SSRF)', async () => {
    // The SSRF guard only validated the initial URL; a 302 to an internal
    // host must not be followed. With redirect:'manual' the platform yields
    // an opaque-redirect (status 0) — assert bindExternalMcp rejects instead
    // of chasing the Location.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.redirect('https://169.254.169.254/latest', 302)),
    );
    await expect(bindExternalMcp(ref('evil'), fakeEnv())).rejects.toThrow(/redirect/i);
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
