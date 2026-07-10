/**
 * SandboxExecutor — sixth tool transport, sibling to `local` / `mcp` /
 * `a2a` / `container` / `queue`.
 *
 * The Sandbox SDK (Cloudflare Workers Sandbox) gives Felix a true
 * filesystem-bearing isolation surface for untrusted code execution.
 * Mirroring `ContainerExecutor`'s shape, this executor speaks a
 * minimal HTTPS-style RPC, but to a worker-local `Fetcher` instead of
 * an external HTTPS gateway — no SSRF guard, no auth-broker header,
 * no signed URL. Production deployments bind it to either:
 *
 *   - a Service binding pointing at a sandbox Worker that wraps the
 *     official `@cloudflare/sandbox` SDK, OR
 *   - a Durable Object stub returned from `namespace.get(id)`, hidden
 *     behind a thin adapter that conforms to `Fetcher`.
 *
 * The Fetcher contract:
 *
 *   POST {prefix}/exec
 *   { "tool":      "<sandbox-side tool name>",
 *     "arguments": { …args },
 *     "session":   "<threadId>"           ← optional, lets the sandbox
 *                                            namespace state by thread
 *     "timeout_ms": <int>?                ← optional
 *   }
 *
 *   200 { "content": "...", "exit_code"?: number, "stderr"?: string }
 *   non-2xx → soft-error `[sandbox error] tool: status …`
 *   exit_code != 0 → soft-error `[sandbox exit N] tool: stderr/content`
 *
 * Cancellation: honors `ctx.signal` and an optional `timeoutMs`
 * watchdog. Composed signal aborts the in-flight fetch.
 *
 * The transport label is `sandbox`; audit / Analytics Engine code can
 * branch on it the same way it branches on `container` or `queue`.
 */

import { z } from 'zod';
import { codeForStatus, toolErrorOutput } from './errors';
import type { ToolExecutor } from './executor';
import {
  defineToolWithExecutor,
  type Tool,
  type ToolInput,
  type ToolInvocationCtx,
  type ToolOutput,
} from './types';

/**
 * Structural fit for `Fetcher` (the type both Service bindings and DO
 * stubs satisfy). Kept narrow so a manifest author can adapt any
 * `fetch`-style binding without forcing a dependency on `@cloudflare/sandbox`.
 */
export interface SandboxFetcher {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export interface SandboxExecutorOpts {
  /** Worker-local Fetcher (Service binding or DO stub). */
  binding: SandboxFetcher;
  /**
   * Logical tool name the sandbox routes on. Distinct from the outward
   * tool name surfaced to the model — one binding can expose many tools.
   */
  sandboxToolName: string;
  /** Optional wall-clock cap, composed with `ctx.signal`. */
  timeoutMs?: number;
  /**
   * Optional path prefix. Defaults to "" so the fetch hits `/exec` on
   * the binding's origin. Useful when the underlying sandbox Worker
   * mounts under a sub-path (e.g. `/sbx/exec`).
   */
  pathPrefix?: string;
}

interface SandboxResponse {
  content?: string;
  exit_code?: number;
  stderr?: string;
}

export class SandboxExecutor implements ToolExecutor {
  readonly transport = 'sandbox';
  constructor(private readonly opts: SandboxExecutorOpts) {}

  async execute(args: ToolInput, ctx?: ToolInvocationCtx): Promise<ToolOutput> {
    const composed = composeSignal(ctx?.signal, this.opts.timeoutMs);
    try {
      const url = `https://sandbox${this.opts.pathPrefix ?? ''}/exec`;
      const body: Record<string, unknown> = {
        tool: this.opts.sandboxToolName,
        arguments: args,
      };
      if (ctx?.threadId) body.session = ctx.threadId;
      if (this.opts.timeoutMs) body.timeout_ms = this.opts.timeoutMs;

      const resp = await this.opts.binding.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(composed.signal ? { signal: composed.signal } : {}),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return toolErrorOutput(
          codeForStatus(resp.status),
          `[sandbox error] ${this.opts.sandboxToolName}: ${resp.status} ${text.slice(0, 200)}`,
        );
      }
      const data = (await resp.json()) as SandboxResponse;
      if (data.exit_code != null && data.exit_code !== 0) {
        const detail = (data.stderr || data.content || '').slice(0, 1000);
        return toolErrorOutput(
          'provider_error',
          `[sandbox exit ${data.exit_code}] ${this.opts.sandboxToolName}: ${detail}`,
        );
      }
      return data.content ?? '[sandbox returned no content]';
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        return toolErrorOutput(
          'user_aborted',
          `[sandbox cancelled] ${this.opts.sandboxToolName}: ${(err as Error).message}`,
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
  dispose: () => void;
}

/**
 * Compose a caller-provided signal with an optional timeout. Mirrors
 * the helper in `container-executor.ts` — kept duplicated rather than
 * factored out so transport executors stay independently auditable.
 */
function composeSignal(callerSignal: AbortSignal | undefined, timeoutMs?: number): ComposedSignal {
  const hasTimeout = timeoutMs != null && timeoutMs > 0;
  if (!callerSignal && !hasTimeout) {
    return { signal: undefined, dispose: () => {} };
  }
  if (callerSignal && !hasTimeout) {
    return { signal: callerSignal, dispose: () => {} };
  }
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (hasTimeout) {
    timeoutId = setTimeout(
      () => controller.abort(new DOMException('sandbox call timed out', 'AbortError')),
      timeoutMs,
    );
  }
  const onAbort = () => controller.abort(callerSignal!.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (callerSignal) callerSignal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Manifest `sandboxes[]` entry — local shape so this module doesn't
 * pull in the full Zod manifest schema. The builder hands us a record
 * that already passed validation; we just need the resolution shape.
 */
export interface SandboxRefLike {
  name: string;
  description?: string;
  /** Worker binding name (Service binding or DO-stub adapter). */
  binding: string;
  /** Defaults to `name` when blank. */
  sandbox_tool_name?: string;
  timeout_ms?: number | null;
  path_prefix?: string;
  args_schema?: Record<string, unknown> | null;
  fatal?: boolean;
}

/**
 * Build a `Tool` whose executor is a `SandboxExecutor`. Pairs the
 * inward Zod schema (permissive `record(unknown)`) with the bound
 * Fetcher; when the manifest declares `args_schema`, it is advertised
 * verbatim through `rawInputSchema` because the sandbox owns input
 * validation.
 */
export function sandboxTool(spec: {
  name: string;
  description: string;
  args: Tool['args'];
  rawInputSchema?: Record<string, unknown>;
  fatal?: boolean;
  binding: SandboxFetcher;
  sandboxToolName: string;
  timeoutMs?: number;
  pathPrefix?: string;
}): Tool {
  return defineToolWithExecutor({
    name: spec.name,
    description: spec.description,
    args: spec.args,
    rawInputSchema: spec.rawInputSchema,
    fatal: spec.fatal,
    source: `sandbox:${spec.sandboxToolName}`,
    executor: new SandboxExecutor({
      binding: spec.binding,
      sandboxToolName: spec.sandboxToolName,
      timeoutMs: spec.timeoutMs,
      pathPrefix: spec.pathPrefix,
    }),
  });
}

/**
 * Build a sandbox-backed `Tool` from a manifest `sandboxes[]` entry.
 * The binding lookup fails the build if the manifest references a
 * binding that wasn't configured in wrangler.jsonc — better to refuse
 * at build than no-op at request time.
 */
export function makeSandboxTool(ref: SandboxRefLike, env: Record<string, unknown>): Tool {
  const binding = env[ref.binding] as SandboxFetcher | undefined;
  if (!binding || typeof binding.fetch !== 'function') {
    throw new Error(
      `sandbox tool '${ref.name}' references binding '${ref.binding}' which is not configured on env — add a Service binding or DO-stub adapter with that name to wrangler.jsonc.`,
    );
  }
  return sandboxTool({
    name: ref.name,
    description: ref.description ?? '',
    args: z.record(z.string(), z.unknown()),
    rawInputSchema: ref.args_schema ?? undefined,
    fatal: ref.fatal ?? false,
    binding,
    sandboxToolName: ref.sandbox_tool_name || ref.name,
    timeoutMs: ref.timeout_ms ?? undefined,
    pathPrefix: ref.path_prefix,
  });
}
