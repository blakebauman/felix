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
  const data = (await resp.json()) as JsonRpcResponse<T>;
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

// A remote MCP server's `description` text and `inputSchema` are injected
// verbatim into the model's tool definitions — the strongest untrusted-input
// prompt-injection surface in the package (a hostile server can plant
// instructions there). We can't sanitize natural-language intent, but we can
// bound the blast radius: cap the description length and reject an oversized
// schema. Build-time (`tools/list`) is also bounded by a timeout so a slow or
// hostile server can't stall `buildAgent` indefinitely.
const MAX_MCP_DESCRIPTION_CHARS = 4096;
const MAX_MCP_SCHEMA_BYTES = 32 * 1024;
const MCP_LIST_TIMEOUT_MS = 10_000;

function capDescription(desc: string): string {
  if (desc.length <= MAX_MCP_DESCRIPTION_CHARS) return desc;
  return `${desc.slice(0, MAX_MCP_DESCRIPTION_CHARS)}… [truncated]`;
}

/**
 * Defense-in-depth filter for the remote `inputSchema`. A malicious or buggy
 * MCP server could send arbitrary JSON here; we forward it to the LLM only
 * when it looks like a JSON Schema object (`type: 'object'`) AND its serialized
 * size is within `MAX_MCP_SCHEMA_BYTES`. Anything else (string, null, missing,
 * wrong type, oversized) falls back to the permissive Zod compile path inside
 * `getToolInputSchema`.
 */
function sanitizeRemoteInputSchema(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.type !== 'object') return undefined;
  // Reject an oversized schema rather than forward a huge nested blob into the
  // model context (injection surface + token blowup).
  try {
    if (JSON.stringify(obj).length > MAX_MCP_SCHEMA_BYTES) return undefined;
  } catch {
    return undefined; // circular / unserializable
  }
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
  // Bound the discovery call so a slow/hostile server can't stall the build.
  const list = await rpc<{ tools: McpTool[] }>(
    ref.url,
    'tools/list',
    {},
    env,
    authHeader,
    AbortSignal.timeout(MCP_LIST_TIMEOUT_MS),
  );
  const out: Tool[] = [];
  for (const t of list.tools ?? []) {
    const namespaced = `${ref.name}__${t.name}`;
    out.push(
      defineToolWithExecutor({
        name: namespaced,
        description: capDescription(t.description ?? `Remote MCP tool ${t.name} on ${ref.name}.`),
        args: z.record(z.string(), z.unknown()),
        rawInputSchema: sanitizeRemoteInputSchema(t.inputSchema),
        source: `mcp:${ref.name}`,
        executor: new McpExecutor(ref, t.name, namespaced, env, authHeaderProvider),
      }),
    );
  }
  return out;
}
