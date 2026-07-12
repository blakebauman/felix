import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import type { McpServerRef } from '../../src/manifests/schema';
import { bindExternalMcp } from '../../src/mcp/client';
import { getToolInputSchema } from '../../src/patterns/zod-to-json-schema';
import { readToolErrorCode } from '../../src/tools/errors';

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

describe('McpExecutor.execute — tools/call error taxonomy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // fetch mock: answer `tools/list` (build time) with one tool, then answer the
  // subsequent `tools/call` with the given non-2xx status.
  function mockCallStatus(status: number) {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const method = JSON.parse(String(init?.body ?? '{}')).method;
      if (method === 'tools/list') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { tools: [{ name: 'search' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('upstream boom', { status });
    });
  }

  async function callWithStatus(status: number) {
    vi.stubGlobal('fetch', mockCallStatus(status));
    const tools = await bindExternalMcp(ref('srv'), fakeEnv());
    const tool = tools[0];
    if (!tool) throw new Error('expected one tool from bindExternalMcp');
    return tool.executor.execute({ q: 'hi' });
  }

  it('surfaces rate_limited (not internal) on a 429 tools/call', async () => {
    const out = await callWithStatus(429);
    expect(readToolErrorCode(out)).toBe('rate_limited');
  });

  it('surfaces provider_error (not internal) on a 500 tools/call', async () => {
    const out = await callWithStatus(500);
    expect(readToolErrorCode(out)).toBe('provider_error');
  });

  it('surfaces permission_denied on a 403 tools/call', async () => {
    const out = await callWithStatus(403);
    expect(readToolErrorCode(out)).toBe('permission_denied');
  });

  it('surfaces provider_error on a JSON-RPC error object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const method = JSON.parse(String(init?.body ?? '{}')).method;
        if (method === 'tools/list') {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { tools: [{ name: 'search' }] } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 'x', error: { code: -32000, message: 'nope' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const tools = await bindExternalMcp(ref('srv'), fakeEnv());
    const out = await tools[0]!.executor.execute({ q: 'hi' });
    expect(readToolErrorCode(out)).toBe('provider_error');
  });
});
