/**
 * BrowserExecutor — seventh tool transport, sibling to `local` / `mcp` /
 * `a2a` / `container` / `queue` / `sandbox`.
 *
 * Cloudflare Browser Rendering exposes a binding that drives a real
 * Chromium isolate. The official path is the `@cloudflare/puppeteer`
 * SDK over the `BrowserWorker` binding, but Felix uses a duck-typed
 * `Fetcher` contract instead — the manifest author wraps puppeteer (or
 * the Browser Rendering REST API) in a small Service-binding Worker
 * whose protocol is the JSON-RPC shape below. Same reason the sandbox
 * transport stays SDK-agnostic: zero new dependencies, zero coupling.
 *
 * The Fetcher contract:
 *
 *   POST {prefix}/{op}
 *   { "url":       "<target URL>",
 *     "options":   { …op-specific args },
 *     "session":   "<threadId>"           ← optional namespace key
 *     "timeout_ms": <int>?
 *   }
 *
 *   200 → text body returned verbatim to the model. For binary ops
 *         (screenshot, pdf) the wrapper Worker is expected to base64-
 *         encode the bytes and return them as text with a leading
 *         `data:image/png;base64,` (etc.) prefix the model can recognize.
 *
 *   non-2xx → soft-error `[browser error/<code>] {op}: status …`
 *
 * Built-in ops we expect a wrapping Worker to expose:
 *   - `content`    HTML of the page
 *   - `links`      extracted hyperlinks
 *   - `snapshot`   `{ html, screenshot_base64 }` JSON
 *   - `screenshot` raw PNG, base64-encoded
 *   - `pdf`        raw PDF, base64-encoded
 *
 * The transport label is `browser`; audit / Analytics Engine code
 * branches on it the same way it branches on `sandbox` or `container`.
 *
 * SSRF NOTE: the `url` the headless browser navigates to is model/tool-arg
 * supplied and is NOT validated by the in-worker SSRF guard (the browser runs
 * in the wrapper Worker / Browser Rendering, not this isolate, so
 * `assertSafeOutboundUrlForEnv` can't contain where it actually connects).
 * Containing browser navigation to internal targets is therefore the wrapping
 * Worker's / Browser Rendering provider's responsibility — the adapter should
 * enforce its own allow-list or egress policy. Manifests should only grant
 * `browser_tools` to trusted agents.
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
 * Structural fit for `Fetcher`. Same shape as `SandboxFetcher` in the
 * sandbox executor; kept named separately so callers reading audit can
 * distinguish a browser binding from a sandbox binding at a glance.
 */
export interface BrowserFetcher {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

/** Built-in ops the wrapping Worker is expected to route on. */
export type BrowserOp = 'content' | 'links' | 'snapshot' | 'screenshot' | 'pdf' | 'json';

export interface BrowserExecutorOpts {
  binding: BrowserFetcher;
  /** Browser-side op the wrapper Worker routes on. */
  op: BrowserOp;
  /** Optional wall-clock cap composed with `ctx.signal`. */
  timeoutMs?: number;
  /** Optional path prefix prepended before `/{op}`. */
  pathPrefix?: string;
}

export class BrowserExecutor implements ToolExecutor {
  readonly transport = 'browser';
  constructor(private readonly opts: BrowserExecutorOpts) {}

  async execute(args: ToolInput, ctx?: ToolInvocationCtx): Promise<ToolOutput> {
    const composed = composeSignal(ctx?.signal, this.opts.timeoutMs);
    try {
      const url = `https://browser${this.opts.pathPrefix ?? ''}/${this.opts.op}`;
      const body: Record<string, unknown> = { ...args };
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
          `[browser error] ${this.opts.op}: ${resp.status} ${text.slice(0, 200)}`,
        );
      }
      // Trust the wrapper Worker to return text (base64 for binary ops).
      // We don't try to JSON-parse here so a `content` op returning raw
      // HTML lands intact.
      const text = await resp.text();
      return text || `[browser ${this.opts.op} returned empty body]`;
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        return toolErrorOutput(
          'user_aborted',
          `[browser cancelled] ${this.opts.op}: ${(err as Error).message}`,
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
      () => controller.abort(new DOMException('browser call timed out', 'AbortError')),
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
 * Manifest `browser_tools[]` entry — kept local so this module doesn't
 * pull in the full Zod manifest schema. The builder hands us records
 * that already passed validation.
 */
export interface BrowserToolRefLike {
  name: string;
  description?: string;
  binding: string;
  op: BrowserOp;
  timeout_ms?: number | null;
  path_prefix?: string;
  args_schema?: Record<string, unknown> | null;
  fatal?: boolean;
}

export function browserTool(spec: {
  name: string;
  description: string;
  args: Tool['args'];
  rawInputSchema?: Record<string, unknown>;
  fatal?: boolean;
  binding: BrowserFetcher;
  op: BrowserOp;
  timeoutMs?: number;
  pathPrefix?: string;
}): Tool {
  return defineToolWithExecutor({
    name: spec.name,
    description: spec.description,
    args: spec.args,
    rawInputSchema: spec.rawInputSchema,
    fatal: spec.fatal,
    source: `browser:${spec.op}`,
    executor: new BrowserExecutor({
      binding: spec.binding,
      op: spec.op,
      timeoutMs: spec.timeoutMs,
      pathPrefix: spec.pathPrefix,
    }),
  });
}

export function makeBrowserTool(ref: BrowserToolRefLike, env: Record<string, unknown>): Tool {
  const binding = env[ref.binding] as BrowserFetcher | undefined;
  if (!binding || typeof binding.fetch !== 'function') {
    throw new Error(
      `browser tool '${ref.name}' references binding '${ref.binding}' which is not configured on env — add a Service binding (or DO-stub adapter) with that name to wrangler.jsonc.`,
    );
  }
  return browserTool({
    name: ref.name,
    description: ref.description ?? '',
    args: z.record(z.string(), z.unknown()),
    rawInputSchema: ref.args_schema ?? undefined,
    fatal: ref.fatal ?? false,
    binding,
    op: ref.op,
    timeoutMs: ref.timeout_ms ?? undefined,
    pathPrefix: ref.path_prefix,
  });
}
