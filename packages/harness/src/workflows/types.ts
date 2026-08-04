/**
 * Shared types for the durable-execution seam.
 *
 * The `AgentWorkflow` *class* is a deployment artifact — it lives in the
 * `apps/api` shell (wrangler.jsonc names it, and it re-composes the tool
 * catalog via the app's wiring root). The harness only needs the payload
 * shape: `wrapDurableAgent` in `manifests/builder.ts` creates instances
 * via `env.AGENT_WORKFLOW.create({ params })`.
 */

import type { ChatMessage } from '../patterns/types';

/**
 * Payload the route handler passes to a Workflow instance via
 * `AGENT_WORKFLOW.create({ params })`. Plain JSON — Workflows
 * serializes params on instance creation.
 */
export interface AgentWorkflowParams {
  tenantId: string;
  principalSubject: string;
  manifestId: string;
  threadId?: string;
  messages: ChatMessage[];
  /**
   * Whether the invocation that created this workflow had a human present.
   *
   * The workflow runs in a fresh isolate and rebuilds its own RequestContext
   * from these params, so anything the governance wrappers read from context
   * has to be carried across explicitly. Dropping this would silently restore
   * attended behavior — a durable-mode manifest invoked from a cron tick would
   * consult and consume human approval grants exactly as if someone were
   * waiting on it.
   */
  unattended?: boolean;
}
