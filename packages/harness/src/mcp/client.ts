/**
 * External MCP client — fetches tools from a remote MCP server (HTTP / SSE)
 * and adapts them to our `Tool` interface.
 *
 * Uses the HTTP JSON-RPC transport:
 *   POST {url} { jsonrpc: 2, method: "tools/list", id: ... }   → list
 *   POST {url} { jsonrpc: 2, method: "tools/call", params: { name, arguments }, id: ... }
 *
 * Tool names are namespaced as `${ref.name}__${tool.name}` to avoid
 * collisions with local tools and other servers.
 *
 * Transport seam: each remote tool carries an `McpExecutor` (transport
 * label = `mcp`) rather than a closure inside `defineTool`. Audit /
 * observability code can branch on `tool.executor.transport` without
 * inspecting names; a future container or queue executor plugs into
 * the same seam.
 *
 * The URL passes through the SSRF guard at every fetch site — manifest
 * parse-time validation catches obvious offenders, but the runtime check
 * is the load-bearing one: an env-allowlisted internal target only opens
 * up at runtime, and we want to fail closed even if a manifest slips past.
 */

import { z } from 'zod';
import type { Env } from '../env';
import type { McpServerRef } from '../manifests/schema';
import { readCappedJson } from '../security/response-limit';
import { assertSafeOutboundUrlForEnv } from '../security/ssrf';
import { toolErrorOutput } from '../tools/errors';
import type { ToolExecutor } from '../tools/executor';
import {
  defineToolWithExecutor,
  type Tool,
  type ToolInput,
  type ToolInvocationCtx,
  type ToolOutput,
} from '../tools/types';

type AuthHeaderProvider = (target: {
  name?: string;
  auth?: string;
  url?: string;
}) => Promise<string>;

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: { code: number; message: string };
}

async function rpc<T>(
  url: string,
  method: string,
  params: unknown,
  env: Env,
  authHeader?: string,
  signal?: AbortSignal,
): Promise<T> {
  // Runtime SSRF check — see `src/security/ssrf.ts`.
  assertSafeOutboundUrlForEnv(url, env);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authHeader ? { authorization: authHeader } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
    ...(signal ? { signal } : {}),
  });
  if (!resp.ok) {
    throw new Error(`MCP ${method} failed: ${resp.status}`);
  }
  // Byte-cap the read so a hostile server can't OOM the isolate with a huge body.
  const data = await readCappedJson<JsonRpcResponse<T>>(resp);
  if (data.error) throw new Error(`MCP error: ${data.error.code} ${data.error.message}`);
  return data.result as T;
}

class McpExecutor implements ToolExecutor {
  readonly transport = 'mcp';
  constructor(
    private readonly ref: McpServerRef,
    private readonly remoteToolName: string,
    private readonly namespacedName: string,
    private readonly env: Env,
    private readonly authProvider?: AuthHeaderProvider,
  ) {}

  async execute(args: ToolInput, ctx?: ToolInvocationCtx): Promise<ToolOutput> {
    try {
      const authHeader = this.authProvider ? await this.authProvider(this.ref) : '';
      const result = await rpc<{ content: Array<{ type: string; text?: string }> }>(
        this.ref.url,
        'tools/call',
        { name: this.remoteToolName, arguments: args },
        this.env,
        authHeader,
        ctx?.signal,
      );
      const text = (result.content ?? [])
        .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
        .join('\n');
      return text || '[mcp tool returned no text content]';
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        return toolErrorOutput(
          'user_aborted',
          `[mcp cancelled] ${this.namespacedName}: ${(err as Error).message}`,
        );
      }
      throw err;
    }
  }
}

/**
 * Defense-in-depth filter for the remote `inputSchema`. A malicious or buggy
 * MCP server could send arbitrary JSON here; we forward it to the LLM only
 * when it looks like a JSON Schema object (`type: 'object'`). Anything else
 * (string, null, missing, wrong type) falls back to the permissive Zod
 * compile path inside `getToolInputSchema`.
 */
function sanitizeRemoteInputSchema(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.type !== 'object') return undefined;
  return obj;
}

export async function bindExternalMcp(
  ref: McpServerRef,
  env: Env,
  authHeaderProvider?: AuthHeaderProvider,
): Promise<Tool[]> {
  // Fail fast if the manifest URL was somehow accepted but is now disallowed
  // (e.g. allow-list edited between deploys).
  assertSafeOutboundUrlForEnv(ref.url, env);
  const authHeader = authHeaderProvider ? await authHeaderProvider(ref) : '';
  const list = await rpc<{ tools: McpTool[] }>(ref.url, 'tools/list', {}, env, authHeader);
  const out: Tool[] = [];
  for (const t of list.tools ?? []) {
    const namespaced = `${ref.name}__${t.name}`;
    out.push(
      defineToolWithExecutor({
        name: namespaced,
        description: t.description ?? `Remote MCP tool ${t.name} on ${ref.name}.`,
        args: z.record(z.string(), z.unknown()),
        rawInputSchema: sanitizeRemoteInputSchema(t.inputSchema),
        source: `mcp:${ref.name}`,
        executor: new McpExecutor(ref, t.name, namespaced, env, authHeaderProvider),
      }),
    );
  }
  return out;
}
