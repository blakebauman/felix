/**
 * Tool execution transport. The harness sees a tool as
 * `{ name, description, args, executor }`; the executor is the thing that
 * actually does work. Anthropic's Managed Agents architecture frames this
 * as brain-hands decoupling: the model loop dispatches by name, the
 * harness routes the call to a `local`, `mcp`, `a2a` (or future
 * `container` / `queue`) executor without the loop knowing the difference.
 *
 * Transport labels are free-form strings so registering a new transport
 * doesn't need a core change. Built-in transports today: `local` (worker-
 * resident handler), `mcp` (remote MCP server), `a2a` (remote A2A peer),
 * `container` (sandbox / container gateway), `queue` (async dispatch
 * resolved via `wake()` + `tasks/resubscribe`).
 */

import type { ToolInput, ToolInvocationCtx, ToolOutput } from './types';

export interface ToolExecutor {
  /** Free-form transport label — used by audit / observability only. */
  readonly transport: string;
  execute(args: ToolInput, ctx?: ToolInvocationCtx): Promise<ToolOutput>;
}

/**
 * Wrap an async handler as a worker-local executor. Used by `defineTool`
 * and by governance wrappers that wrap an inner executor's call.
 */
export function localExecutor(
  execute: (args: ToolInput, ctx?: ToolInvocationCtx) => Promise<ToolOutput>,
): ToolExecutor {
  return { transport: 'local', execute };
}

/**
 * Wrap an existing executor in a function that runs `before` checks and
 * delegates to the inner executor on pass. Used by governance wrappers
 * (policy / limits / guardrails / approvals). Preserves the inner
 * executor's `transport` so audit labels remain accurate.
 */
export function wrapExecutor(
  inner: ToolExecutor,
  execute: (args: ToolInput, ctx: ToolInvocationCtx | undefined) => Promise<ToolOutput>,
): ToolExecutor {
  return { transport: inner.transport, execute };
}
