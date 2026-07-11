/**
 * ContainerExecutor — a `ToolExecutor` whose transport is an external
 * sandbox / container runner.
 *
 * Anthropic's Managed Agents framing: the brain (model loop) calls
 * `execute(name, input) → string`; the harness routes the call to a
 * sandbox container so untrusted work runs in isolation. The transport
 * shows up in audit as `transport: 'container'`.
 *
 * The executor is provider-agnostic — anywhere reachable by HTTPS will
 * do (a Cloudflare Container, an internal sandbox service, an external
 * code-exec provider). The gateway only needs to accept this protocol:
 *
 *   POST {gatewayUrl}
 *   { "image": "<image-or-sandbox-id>",
 *     "tool":  "<tool-name>",
 *     "arguments": { ...args } }
 *
 *   200 { "content": "...", "exit_code"?: number, "stderr"?: string }
 *   non-2xx → `[container error] image: status …`
 *   exit_code != 0 → `[container exit N] tool: stderr/content …`
 *
 * Credentials never reach the sandbox by default — the executor adds an
 * `Authorization` header to the gateway request (the gateway is trusted
 * to scope what runs inside). Resource-bundled auth (passing a token
 * inside `args` for the container to consume) is a manifest-author
 * choice, not a default. This mirrors the *vault-backed tools* pattern
 * the article describes for MCP proxies.
 *
 * Cancellation: honors `ctx.signal` from the request scope and a per-
 * call `timeoutMs` watchdog. Either firing aborts the in-flight fetch
 * via a composed AbortSignal.
 */

import { z } from 'zod';
import type { Env } from '../env';
import { readCappedJson } from '../security/response-limit';
import { assertSafeOutboundUrlForEnv } from '../security/ssrf';
import { codeForStatus, ToolError, toolErrorOutput } from './errors';
import type { ToolExecutor } from './executor';
import {
  defineToolWithExecutor,
  type Tool,
  type ToolInput,
  type ToolInvocationCtx,
  type ToolOutput,
} from './types';

type AuthProvider = () => Promise<string>;

export interface ContainerExecutorOpts {
  /** HTTPS URL of the container gateway (Cloudflare Container, sandbox
   *  service, etc.). SSRF-guarded at every fetch site. */
  gatewayUrl: string;
  /** Image / sandbox identifier the gateway should run. Free-form. */
  image: string;
  /** Tool name as seen inside the container (defaults to the outward
   *  `Tool.name`). Lets a single image expose multiple tools. */
  containerToolName: string;
  env: Env;
  /** Optional auth header lookup. Same broker-style indirection used by
   *  MCP / A2A executors — keeps the raw token out of the executor's
   *  closure. */
  authProvider?: AuthProvider;
  /** Optional wall-clock cap on the container call, in milliseconds.
   *  Composed with `ctx.signal` so either signal aborts the fetch. */
  timeoutMs?: number;
}

interface ContainerResponse {
  content?: string;
  exit_code?: number;
  stderr?: string;
}

export class ContainerExecutor implements ToolExecutor {
  readonly transport = 'container';
  constructor(private readonly opts: ContainerExecutorOpts) {}

  async execute(args: ToolInput, ctx?: ToolInvocationCtx): Promise<ToolOutput> {
    assertSafeOutboundUrlForEnv(this.opts.gatewayUrl, this.opts.env);

    const composed = composeSignal(ctx?.signal, this.opts.timeoutMs);
    try {
      const authHeader = this.opts.authProvider ? await this.opts.authProvider() : '';
      const resp = await fetch(this.opts.gatewayUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authHeader ? { authorization: authHeader } : {}),
        },
        body: JSON.stringify({
          image: this.opts.image,
          tool: this.opts.containerToolName,
          arguments: args,
        }),
        ...(composed.signal ? { signal: composed.signal } : {}),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        return toolErrorOutput(
          codeForStatus(resp.status),
          `[container error] ${this.opts.image}: ${resp.status} ${body.slice(0, 200)}`,
        );
      }
      // Byte-cap the read so a hostile/compromised gateway can't OOM the isolate.
      const data = await readCappedJson<ContainerResponse>(resp);
      if (data.exit_code != null && data.exit_code !== 0) {
        const detail = (data.stderr || data.content || '').slice(0, 1000);
        return toolErrorOutput(
          'provider_error',
          `[container exit ${data.exit_code}] ${this.opts.containerToolName}: ${detail}`,
        );
      }
      return data.content ?? '[container returned no content]';
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        return toolErrorOutput(
          'user_aborted',
          `[container cancelled] ${this.opts.containerToolName}: ${(err as Error).message}`,
        );
      }
      if (err instanceof ToolError) {
        return toolErrorOutput(err.code, `[container error] ${this.opts.image}: ${err.message}`);
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
 * Compose a caller-provided signal with an optional timeout. Returns a
 * single signal that fires when either source fires, plus a `dispose`
 * that clears the timer. Avoids `AbortSignal.any` for Workers runtime
 * compatibility (some runtimes don't have it yet).
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
      () => controller.abort(new DOMException('container call timed out', 'AbortError')),
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
 * Build a `Tool` whose executor is a `ContainerExecutor`. Mirrors
 * `defineTool` ergonomics. Use this in `composition.ts` (or anywhere
 * tools are registered) to expose a container-backed capability to the
 * model loop.
 */
export function containerTool(spec: {
  name: string;
  description: string;
  args: Tool['args'];
  rawInputSchema?: Record<string, unknown>;
  fatal?: boolean;
  gatewayUrl: string;
  image: string;
  /** Defaults to `spec.name`. */
  containerToolName?: string;
  env: Env;
  authProvider?: AuthProvider;
  timeoutMs?: number;
}): Tool {
  return defineToolWithExecutor({
    name: spec.name,
    description: spec.description,
    args: spec.args,
    rawInputSchema: spec.rawInputSchema,
    fatal: spec.fatal,
    source: `container:${spec.image}`,
    executor: new ContainerExecutor({
      gatewayUrl: spec.gatewayUrl,
      image: spec.image,
      containerToolName: spec.containerToolName ?? spec.name,
      env: spec.env,
      authProvider: spec.authProvider,
      timeoutMs: spec.timeoutMs,
    }),
  });
}

/**
 * Shape of a manifest `containers[]` entry (kept local so this module
 * doesn't import the full Zod manifest schema). The builder hands us a
 * record that already passed schema validation; we just have to wire it.
 */
export interface ContainerRefLike {
  name: string;
  description?: string;
  gateway_url: string;
  image: string;
  container_tool_name?: string;
  timeout_ms?: number | null;
  auth?: string;
  args_schema?: Record<string, unknown> | null;
  fatal?: boolean;
}

/**
 * Build a container-backed `Tool` from a manifest `containers[]` entry.
 * The auth header is resolved through the caller-supplied broker (same
 * indirection MCP / A2A use) so the raw token never lands in this
 * module's closure.
 *
 * When the manifest declares `args_schema`, it is advertised to the model
 * verbatim through `rawInputSchema`; the inward Zod schema stays
 * permissive (`record(unknown)`) because the gateway owns validation.
 */
export function makeContainerTool(
  ref: ContainerRefLike,
  env: Env,
  authHeaderProvider?: (target: { name?: string; auth?: string; url?: string }) => Promise<string>,
): Tool {
  const authProvider: AuthProvider | undefined =
    authHeaderProvider && ref.auth
      ? async () => authHeaderProvider({ name: ref.name, auth: ref.auth, url: ref.gateway_url })
      : undefined;
  return containerTool({
    name: ref.name,
    description: ref.description ?? '',
    args: z.record(z.string(), z.unknown()),
    rawInputSchema: ref.args_schema ?? undefined,
    fatal: ref.fatal ?? false,
    gatewayUrl: ref.gateway_url,
    image: ref.image,
    containerToolName: ref.container_tool_name || ref.name,
    env,
    authProvider,
    timeoutMs: ref.timeout_ms ?? undefined,
  });
}
