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
import { assertSafeOutboundUrlForEnv, isRedirect } from '../security/ssrf';
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
    // Don't follow redirects: the SSRF guard only validated the initial URL,
    // so a 3xx to an internal address (IMDS/RFC1918) would bypass it. These
    // are JSON-RPC POST endpoints that have no legitimate reason to redirect.
    redirect: 'manual',
    ...(signal ? { signal } : {}),
  });
  if (isRedirect(resp)) {
    throw new Error(`MCP ${method} refused: server attempted a redirect`);
  }
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
    // Compose the request-scoped signal with a per-call timeout so a slow or
    // hung server can't hold the loop open until the request wall-clock limit
    // fires (which is only configured on some manifests). Either source aborts.
    const composed = composeSignal(ctx?.signal, MCP_CALL_TIMEOUT_MS);
    try {
      const authHeader = this.authProvider ? await this.authProvider(this.ref) : '';
      const result = await rpc<{ content: Array<{ type: string; text?: string }> }>(
        this.ref.url,
        'tools/call',
        { name: this.remoteToolName, arguments: args },
        this.env,
        authHeader,
        composed.signal,
      );
      const text = (result.content ?? [])
        .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
        .join('\n');
      return text || '[mcp tool returned no text content]';
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        if (composed.timedOut) {
          return toolErrorOutput(
            'timeout',
            `[mcp timeout] ${this.namespacedName}: exceeded ${MCP_CALL_TIMEOUT_MS}ms`,
          );
        }
        return toolErrorOutput(
          'user_aborted',
          `[mcp cancelled] ${this.namespacedName}: ${(err as Error).message}`,
        );
      }
      throw err;
    } finally {
      composed.dispose();
    }
  }
}

interface ComposedSignal {
  signal: AbortSignal | undefined;
  /** True once the composed timeout fired (vs a caller-driven abort). */
  readonly timedOut: boolean;
  dispose: () => void;
}

/**
 * Compose a caller-provided signal with an optional timeout. Returns a single
 * signal that fires when either source fires, a `timedOut` flag so the caller
 * can distinguish a per-call timeout from a request-scoped cancel, plus a
 * `dispose` that clears the timer. Avoids `AbortSignal.any` for Workers runtime
 * compatibility (mirrors `tools/container-executor.ts`).
 */
function composeSignal(callerSignal: AbortSignal | undefined, timeoutMs?: number): ComposedSignal {
  const hasTimeout = timeoutMs != null && timeoutMs > 0;
  if (!callerSignal && !hasTimeout) {
    return { signal: undefined, timedOut: false, dispose: () => {} };
  }
  if (callerSignal && !hasTimeout) {
    return { signal: callerSignal, timedOut: false, dispose: () => {} };
  }
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (hasTimeout) {
    timeoutId = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort(new DOMException('mcp call timed out', 'AbortError'));
    }, timeoutMs);
  }
  const onAbort = () => controller.abort(callerSignal!.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (callerSignal) callerSignal.removeEventListener('abort', onAbort);
    },
  };
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
// Default per-call cap on `tools/call` — a slow/hung server otherwise hangs
// until the request wall-clock limit fires, and only when one is configured.
const MCP_CALL_TIMEOUT_MS = 30_000;

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
