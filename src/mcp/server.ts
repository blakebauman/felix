/**
 * Minimal MCP HTTP JSON-RPC server. Two methods are exposed:
 * `tools/list` and `tools/call`. Each tool's args are described via the
 * Zod-to-JSON-Schema converter so MCP clients can render the inputs.
 *
 * SSE transport is a follow-up — the JSON-RPC over HTTP transport is the
 * simplest interop story and the one our `mcp/client.ts` consumes.
 *
 * The default manifest's `auth.inbound` gates anonymous access — when the
 * manifest doesn't `allow_anonymous`, callers must present a verified JWT.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { BearerSecurity } from '../api/openapi-shared';
import type { AuthContext } from '../auth/context';
import { enforceManifestAuth } from '../auth/middleware';
import type { Env } from '../env';
import { buildAgent } from '../manifests/builder';
import { loadManifest } from '../manifests/loader';
import { getToolInputSchema } from '../patterns/zod-to-json-schema';
import type { ToolProvider } from '../tools/provider';

const JrpcEnvelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
});

const McpToolsCallParams = z
  .object({
    name: z.string().openapi({ description: 'Tool name to invoke.' }),
    arguments: z.record(z.string(), z.unknown()).optional().openapi({
      description: 'Tool arguments. Shape comes from the tool’s `inputSchema` (see tools/list).',
    }),
  })
  .openapi('McpToolsCallParams');

const McpRequestSchema = z
  .discriminatedUnion('method', [
    JrpcEnvelope.extend({
      method: z.literal('tools/list'),
      params: z.object({}).optional(),
    }),
    JrpcEnvelope.extend({ method: z.literal('tools/call'), params: McpToolsCallParams }),
  ])
  .openapi('McpRequest');

const McpToolDescriptorSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    inputSchema: z
      .record(z.string(), z.unknown())
      .openapi({ description: 'JSON Schema for the tool’s arguments.' }),
  })
  .openapi('McpToolDescriptor');

const McpResponseSchema = z
  .union([
    z.object({
      jsonrpc: z.literal('2.0'),
      id: z.union([z.number(), z.string(), z.null()]),
      result: z.union([
        z.object({ tools: z.array(McpToolDescriptorSchema) }),
        z.object({
          content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
        }),
      ]),
    }),
    z.object({
      jsonrpc: z.literal('2.0'),
      id: z.union([z.number(), z.string(), z.null()]),
      error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }),
    }),
  ])
  .openapi('McpResponse');

const mcpRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['MCP'],
  summary: 'MCP HTTP JSON-RPC entrypoint',
  description:
    'JSON-RPC 2.0 over HTTP. The body is a discriminated union on `method`: ' +
    '`tools/list` (no params) and `tools/call` (`{ name, arguments? }`).',
  security: BearerSecurity(),
  request: {
    body: { required: true, content: { 'application/json': { schema: McpRequestSchema } } },
  },
  responses: {
    200: {
      description: 'JSON-RPC envelope (result or error).',
      content: { 'application/json': { schema: McpResponseSchema } },
    },
  },
});

interface JrpcLike {
  id?: number | string | null;
}

export function buildMcpRouter(deps: { tools: ToolProvider; defaultManifest: string }) {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const raw = (result as { target?: unknown }).target as JrpcLike | undefined;
        const id = typeof raw?.id === 'string' || typeof raw?.id === 'number' ? raw.id : null;
        return c.json({
          jsonrpc: '2.0' as const,
          id,
          error: {
            code: -32600,
            message: 'invalid request',
            data: result.error.message.slice(0, 500),
          },
        });
      }
    },
  });

  router.openapi(mcpRoute, async (c) => {
    const req = c.req.valid('json');
    const manifest = loadManifest(deps.defaultManifest);
    const denied = enforceManifestAuth(c, manifest);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const agent = await buildAgent(manifest, { env: c.env, tools: deps.tools, auth });

    if (req.method === 'tools/list') {
      return c.json({
        jsonrpc: '2.0' as const,
        id: req.id,
        result: {
          tools: agent.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: getToolInputSchema(t),
          })),
        },
      });
    }
    // tools/call
    const params = req.params;
    const tool = agent.tools.find((t) => t.name === params.name);
    if (!tool) {
      return c.json({
        jsonrpc: '2.0' as const,
        id: req.id,
        error: { code: -32601, message: `unknown tool: ${params.name}` },
      });
    }
    const out = await tool.executor.execute(params.arguments ?? {});
    const text = typeof out === 'string' ? out : out.content;
    return c.json({
      jsonrpc: '2.0' as const,
      id: req.id,
      result: { content: [{ type: 'text' as const, text }] },
    });
  });

  return router;
}
