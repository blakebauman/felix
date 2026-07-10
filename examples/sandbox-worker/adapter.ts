/**
 * Reference adapter Worker for Felix's `sandbox` tool transport.
 *
 * Felix's `SandboxExecutor` (`src/tools/sandbox-executor.ts`) expects a
 * `Fetcher` binding that speaks this protocol:
 *
 *   POST {prefix}/exec
 *   { "tool":        "<sandbox-side tool name>",
 *     "arguments":   { ...tool args },
 *     "session":     "<threadId>",        ← optional namespace key
 *     "timeout_ms":  <int>?               ← optional
 *   }
 *
 *   200 { "content": "...", "exit_code"?: number, "stderr"?: string }
 *   non-2xx → SandboxExecutor surfaces a `[sandbox error]` ToolOutput
 *             with `codeForStatus` mapping (429 → rate_limited, etc.)
 *
 * This Worker bridges that contract to the official `@cloudflare/sandbox`
 * SDK, keying one sandbox per `session` so file state persists across
 * the same conversation's turns. Drop it into your account, deploy
 * separately, then point Felix at it via a Service binding:
 *
 *   // Felix's wrangler.jsonc
 *   "services": [{ "binding": "SANDBOX", "service": "felix-sandbox-worker" }]
 *
 *   // Felix's manifest
 *   spec:
 *     sandboxes:
 *       - name: code_exec
 *         binding: SANDBOX
 *         sandbox_tool_name: code_exec
 *         timeout_ms: 30000
 *
 * The Sandbox class is re-exported from this Worker so wrangler can
 * resolve it for the Durable Object binding declared in the
 * companion `wrangler.example.jsonc`.
 *
 * NOTE: API surface here matches `@cloudflare/sandbox` as of writing
 * — check the package README for the current method names if your
 * deploy fails to compile (`exec`, `writeFile`, `readFile`, `listFiles`).
 */

import { getSandbox, Sandbox } from '@cloudflare/sandbox';

export { Sandbox };

interface Env {
  /** Durable Object namespace bound to the re-exported Sandbox class. */
  Sandbox: DurableObjectNamespace;
}

interface ExecRequest {
  tool: string;
  arguments: Record<string, unknown>;
  session?: string;
  timeout_ms?: number;
}

interface ExecResponse {
  content: string;
  exit_code?: number;
  stderr?: string;
}

const DEFAULT_SESSION = 'default';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }
    const path = new URL(req.url).pathname;
    if (!path.endsWith('/exec')) {
      return new Response('not found', { status: 404 });
    }
    let body: ExecRequest;
    try {
      body = (await req.json()) as ExecRequest;
    } catch {
      return new Response('bad json', { status: 400 });
    }
    if (!body.tool) {
      return new Response('missing tool', { status: 400 });
    }

    // One sandbox per conversation thread. The session id Felix passes
    // through is the full `tenant:thread-suffix` from the request
    // context — already tenant-scoped, so no extra prefix needed.
    const sandbox = getSandbox(env.Sandbox, body.session ?? DEFAULT_SESSION);

    try {
      const result = await dispatch(sandbox, body);
      return Response.json(result satisfies ExecResponse);
    } catch (err) {
      const message = String((err as Error).message ?? err);
      // 5xx → SandboxExecutor surfaces as `provider_error` and the
      // model gets a `[sandbox error]` ToolOutput it can recover from.
      return Response.json(
        { content: '', stderr: message, exit_code: 1 } satisfies ExecResponse,
        { status: 500 },
      );
    }
  },
};

/**
 * Dispatch the request body to the appropriate sandbox primitive.
 * Each branch returns `ExecResponse` so Felix's executor reads a
 * consistent shape regardless of which tool fired.
 */
async function dispatch(
  sandbox: ReturnType<typeof getSandbox>,
  body: ExecRequest,
): Promise<ExecResponse> {
  switch (body.tool) {
    case 'code_exec': {
      const code = String(body.arguments.code ?? '');
      const language = String(body.arguments.language ?? 'python');
      if (!code) return { content: '', stderr: 'missing code', exit_code: 1 };
      // Sandbox SDK shells out to whatever runtime is in the
      // underlying image. For Python: `python3 -c <code>`. Swap to
      // `node -e`, `deno eval`, etc. by editing this map.
      const cmd = language === 'python' ? 'python3' : language;
      const result = await sandbox.exec(cmd, ['-c', code]);
      return {
        content: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exit_code: result.exitCode ?? 0,
      };
    }
    case 'fs_read': {
      const path = String(body.arguments.path ?? '');
      if (!path) return { content: '', stderr: 'missing path', exit_code: 1 };
      const content = await sandbox.readFile(path);
      return { content };
    }
    case 'fs_write': {
      const path = String(body.arguments.path ?? '');
      const content = String(body.arguments.content ?? '');
      if (!path) return { content: '', stderr: 'missing path', exit_code: 1 };
      await sandbox.writeFile(path, content);
      return { content: `wrote ${content.length} bytes to ${path}` };
    }
    case 'fs_list': {
      const path = String(body.arguments.path ?? '/workspace');
      const entries = await sandbox.listFiles(path);
      return { content: JSON.stringify(entries) };
    }
    case 'shell': {
      const cmd = String(body.arguments.cmd ?? '');
      const args = Array.isArray(body.arguments.args) ? (body.arguments.args as string[]) : [];
      if (!cmd) return { content: '', stderr: 'missing cmd', exit_code: 1 };
      const result = await sandbox.exec(cmd, args);
      return {
        content: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exit_code: result.exitCode ?? 0,
      };
    }
    default:
      return { content: '', stderr: `unknown sandbox tool: ${body.tool}`, exit_code: 1 };
  }
}
