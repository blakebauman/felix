/**
 * Tool runtime types.
 *
 * A tool has a `name`, `description`, an `args` Zod schema, and a
 * `ToolExecutor` that actually runs the work. The executor is the
 * brain-hands seam: the model loop calls `tool.executor.execute(args,
 * ctx)`, the harness routes to a local / mcp / a2a (or future container)
 * transport. Tool results are stringified before being handed back to
 * the LLM (the react loop expects strings).
 *
 * `defineTool` wraps a Zod schema + an async handler into a Tool whose
 * executor is a `localExecutor` that parses args and calls the handler.
 * For tools whose execution owns its own validation (remote MCP / A2A),
 * use `defineToolWithExecutor` and let the executor decide what to
 * validate.
 */

import type { z } from 'zod';
import { toolErrorOutput } from './errors';
import { localExecutor, type ToolExecutor } from './executor';

/** A JSON value the LLM/tool layer can serialize. */
export type ToolInput = Record<string, unknown>;

export type ToolOutput = string | { content: string; metadata?: Record<string, unknown> };

/**
 * Metadata key used by governance wrappers to mark their deny outputs.
 * Outer wrappers (especially post-call ones like guardrails output filters)
 * MUST check `isWrapperDeny(output)` before doing any work — otherwise they
 * end up filtering / scoring / approving an inner wrapper's deny string,
 * which is at best wasted work and at worst masks the deny.
 *
 * The string content always survives to the LLM; the metadata flag is the
 * only thing wrappers should branch on.
 */
export const WRAPPER_DENY_FLAG = '__felix_wrapper_deny__';
export type WrapperSource = 'policy' | 'limits' | 'guardrails' | 'approvals';

export function denyOutput(content: string, source: WrapperSource): ToolOutput {
  return { content, metadata: { [WRAPPER_DENY_FLAG]: true, source } };
}

export function isWrapperDeny(output: ToolOutput): boolean {
  if (typeof output === 'string') return false;
  return output.metadata?.[WRAPPER_DENY_FLAG] === true;
}

export interface ToolInvocationCtx {
  /** Manifest that wrapped this call — passed through for audit context. */
  manifestId?: string;
  /**
   * The model's `tool_call_id` for this invocation. Set by the react /
   * deep loop. Async transports (queue) need this to write a deferred
   * `tool_result` back to the session keyed to the right cycle; sync
   * transports can ignore it.
   */
  toolCallId?: string;
  /**
   * The session thread this tool call belongs to. Pattern-scoped, not
   * request-scoped — so a router-forwarded child still sees the parent's
   * threadId, while a parallel child (which deliberately strips it) sees
   * no threadId and async transports correctly refuse to enqueue work
   * that can never be paired back to a session.
   */
  threadId?: string;
  /**
   * Aborted when a per-run wall-clock limit is breached or the request is
   * torn down. Tools that perform fetch / long-running work should pass
   * this signal through (e.g. `fetch(url, { signal })`) so cancellation
   * actually interrupts mid-flight rather than only blocking the next call.
   */
  signal?: AbortSignal;
}

export interface Tool {
  /** Stable identifier exposed to the LLM. */
  readonly name: string;
  /** Human/LLM-readable description surfaced to the model. */
  readonly description: string;
  /** Zod schema describing tool inputs. */
  readonly args: z.ZodTypeAny;
  /**
   * Optional pre-built JSON Schema describing tool inputs. When set, this is
   * advertised to LLMs / MCP clients verbatim instead of converting `args`.
   * Used for tools whose schema originates as JSON Schema (e.g. remote MCP
   * tools) — avoids a lossy JSON-Schema → Zod → JSON-Schema round-trip.
   */
  readonly rawInputSchema?: Record<string, unknown>;
  /** True for peer tools (`peer_*`) so the limits wrapper can count hops. */
  readonly isPeer?: boolean;
  /** Optional source label for observability (e.g. "mcp:stripe"). */
  readonly source?: string;
  /**
   * When true, an exception thrown from `executor.execute` terminates the
   * react loop instead of being stringified and fed back to the model. Use
   * sparingly for non-recoverable conditions (security violations, hard
   * quota exhaustion). The default behavior — string-ifying errors so the
   * model can recover — is correct for most tools.
   */
  readonly fatal?: boolean;
  /**
   * The transport-aware executor for this tool. Local tools get a
   * `localExecutor` that parses args + calls a handler. MCP / A2A tools
   * supply their own executor; the executor owns transport-specific
   * concerns (URL, auth header lookup, signal propagation, response
   * shaping). Governance wrappers replace this field with a wrapping
   * executor that preserves the inner `transport` label.
   */
  readonly executor: ToolExecutor;
}

/** Convenience constructor for worker-local tools. */
export function defineTool<S extends z.ZodTypeAny>(spec: {
  name: string;
  description: string;
  args: S;
  rawInputSchema?: Record<string, unknown>;
  isPeer?: boolean;
  source?: string;
  fatal?: boolean;
  handler: (args: z.infer<S>, ctx?: ToolInvocationCtx) => Promise<ToolOutput>;
}): Tool {
  return {
    name: spec.name,
    description: spec.description,
    args: spec.args,
    rawInputSchema: spec.rawInputSchema,
    isPeer: spec.isPeer ?? false,
    source: spec.source,
    fatal: spec.fatal ?? false,
    executor: localExecutor(async (args, ctx) => {
      const parsed = spec.args.safeParse(args);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ');
        return toolErrorOutput('invalid_arguments', `[invalid args for ${spec.name}] ${detail}`);
      }
      return spec.handler(parsed.data, ctx);
    }),
  };
}

/**
 * Construct a `Tool` with a caller-supplied executor. The executor is
 * responsible for any args validation it needs; the harness will not
 * pre-parse against `args` before dispatching (use `defineTool` if you
 * want that). Used for non-local transports — MCP / A2A — whose
 * executors encapsulate their own validation + transport.
 */
export function defineToolWithExecutor(spec: {
  name: string;
  description: string;
  args: z.ZodTypeAny;
  rawInputSchema?: Record<string, unknown>;
  isPeer?: boolean;
  source?: string;
  fatal?: boolean;
  executor: ToolExecutor;
}): Tool {
  return {
    name: spec.name,
    description: spec.description,
    args: spec.args,
    rawInputSchema: spec.rawInputSchema,
    isPeer: spec.isPeer ?? false,
    source: spec.source,
    fatal: spec.fatal ?? false,
    executor: spec.executor,
  };
}
