/**
 * A2A client — call a remote orchestrator via the JSON-RPC `tasks/send`
 * method and expose the call as a local tool named `peer_<name>`. The
 * limits wrapper increments `peer_hops` for any tool whose name starts
 * with `peer_` — that prefix is the contract.
 *
 * The peer URL passes through the SSRF guard at fetch time. We also build
 * the request URL via `new URL('/a2a', base)` so a trailing-`?` peer URL
 * can't smuggle the path into a query string.
 *
 * Transport seam: each peer tool carries an `A2AExecutor` (transport
 * label = `a2a`) rather than a closure inside `defineTool`. Audit /
 * observability code can branch on `tool.executor.transport` without
 * inspecting the `peer_` name prefix. The executor owns args validation
 * (only `{ message: string }` is allowed); invalid args return a string
 * the model can recover from instead of throwing.
 */

import { z } from 'zod';
import type { Env } from '../env';
import type { A2APeerRef } from '../manifests/schema';
import { readCappedJson } from '../security/response-limit';
import { assertSafeOutboundUrlForEnv, isRedirect } from '../security/ssrf';
import { codeForStatus, ToolError, toolErrorOutput } from '../tools/errors';
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

interface TaskSendParams {
  task: {
    id: string;
    input: {
      messages: Array<{ role: string; content: string }>;
    };
    continuation?: unknown;
  };
}

interface TaskSendResult {
  id: string;
  status: 'completed' | 'failed' | 'in_progress' | string;
  output?: {
    messages?: Array<{ role: string; content: string }>;
  };
  error?: string;
}

// Default per-call cap on a peer `tasks/send` — a slow/hung peer otherwise
// hangs until the request wall-clock limit fires, and only when one is set.
const A2A_CALL_TIMEOUT_MS = 30_000;

function peerEndpoint(base: string): string {
  // Safer than string concat — handles trailing slashes and rejects
  // anything URL-unparseable.
  return new URL('a2a', base.endsWith('/') ? base : `${base}/`).toString();
}

class A2AExecutor implements ToolExecutor {
  readonly transport = 'a2a';
  constructor(
    private readonly ref: A2APeerRef,
    private readonly env: Env,
    private readonly authProvider?: AuthHeaderProvider,
  ) {}

  async execute(args: ToolInput, ctx?: ToolInvocationCtx): Promise<ToolOutput> {
    const message = args.message;
    if (typeof message !== 'string') {
      return toolErrorOutput(
        'invalid_arguments',
        `[invalid args for peer_${this.ref.name}] message: required string`,
      );
    }
    assertSafeOutboundUrlForEnv(this.ref.url, this.env);
    const authHeader = this.authProvider ? await this.authProvider(this.ref) : '';
    const params: TaskSendParams = {
      task: {
        id: crypto.randomUUID(),
        input: { messages: [{ role: 'user', content: message }] },
      },
    };
    // Compose the request-scoped signal with a per-call timeout so a slow or
    // hung peer can't hold the loop open until the request wall-clock limit
    // fires (which is only configured on some manifests). Either source aborts.
    const composed = composeSignal(ctx?.signal, A2A_CALL_TIMEOUT_MS);
    try {
      const resp = await fetch(peerEndpoint(this.ref.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authHeader ? { authorization: authHeader } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: crypto.randomUUID(),
          method: 'tasks/send',
          params,
        }),
        // Don't follow redirects: the SSRF guard only validated the initial
        // peer URL, so a 3xx to an internal host would bypass it.
        redirect: 'manual',
        ...(composed.signal ? { signal: composed.signal } : {}),
      });
      if (isRedirect(resp)) {
        return toolErrorOutput(
          'provider_error',
          `[peer error] ${this.ref.name}: server attempted a redirect`,
        );
      }
      if (!resp.ok) {
        return toolErrorOutput(
          codeForStatus(resp.status),
          `[peer error] ${this.ref.name}: ${resp.status}`,
        );
      }
      // Byte-cap the read so a hostile peer can't OOM the isolate.
      const data = await readCappedJson<{
        result?: TaskSendResult;
        error?: { message: string };
      }>(resp);
      if (data.error)
        return toolErrorOutput(
          'provider_error',
          `[peer error] ${this.ref.name}: ${data.error.message}`,
        );
      const last = data.result?.output?.messages?.slice(-1)[0];
      return last?.content ?? '[peer returned no message]';
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        if (composed.timedOut) {
          return toolErrorOutput(
            'timeout',
            `[peer timeout] ${this.ref.name}: exceeded ${A2A_CALL_TIMEOUT_MS}ms`,
          );
        }
        return toolErrorOutput(
          'user_aborted',
          `[peer cancelled] ${this.ref.name}: ${(err as Error).message}`,
        );
      }
      if (err instanceof ToolError) {
        return toolErrorOutput(err.code, `[peer error] ${this.ref.name}: ${err.message}`);
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
      controller.abort(new DOMException('peer call timed out', 'AbortError'));
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

export function makePeerTool(
  ref: A2APeerRef,
  env: Env,
  authHeaderProvider?: AuthHeaderProvider,
): Tool {
  return defineToolWithExecutor({
    name: `peer_${ref.name}`,
    description: `Delegate the user's request to the remote A2A peer '${ref.name}'.`,
    args: z.object({
      message: z.string().describe('Message to send to the peer.'),
    }),
    isPeer: true,
    source: `a2a:${ref.name}`,
    executor: new A2AExecutor(ref, env, authHeaderProvider),
  });
}
