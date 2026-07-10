/**
 * AgentWorkflow — Cloudflare Workflows entrypoint for durable agent
 * execution.
 *
 * Phase-3 framing: a manifest with `spec.execution.mode = 'durable'` no
 * longer runs the model loop in the request isolate. Instead, the
 * builder's `wrapDurableAgent` returns an `Agent` whose `invoke()`
 * creates a Workflow instance with the request's `{tenantId, manifestId,
 * threadId, messages, principalSubject}` payload and polls for
 * completion. The Workflow re-resolves the manifest, forces
 * `execution.mode = transient` to avoid recursion, rebuilds the
 * underlying `Agent`, and runs the invocation inside `step.do(...)` with
 * retries — so a worker eviction mid-run replays the step from scratch
 * instead of losing the branch.
 *
 * Cycle guard: schema mutation, not env mutation. The workflow rebuilds
 * the manifest with `execution.mode` forced to `transient`, so the
 * inner `buildAgent` call lands on the underlying `react`/`deep`
 * pattern. Keeping the guard at the schema level rather than at the
 * env level keeps the workflow's input shape self-describing.
 *
 * This module deliberately avoids importing `buildAgent` directly to
 * sidestep a circular dependency with `src/manifests/builder.ts`; the
 * resolved manifest is rebuilt via a dynamic import once the workflow
 * is already executing.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
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
}

export class AgentWorkflow extends WorkflowEntrypoint<Env, AgentWorkflowParams> {
  override async run(
    event: WorkflowEvent<AgentWorkflowParams>,
    step: WorkflowStep,
  ): Promise<string> {
    const { tenantId, principalSubject, manifestId, threadId, messages } = event.payload;
    // The step returns a JSON-encoded `InvokeResult`. Workflows'
    // `Serializable<T>` constraint is structural and rejects the
    // recursive object shapes we use for messages / tool_calls; a
    // string is trivially serializable and the wrap on the read side
    // parses it back. `JSON.stringify` doubles as a tripwire — any
    // non-JSON-safe data the agent produces fails fast here rather
    // than getting silently dropped by the workflow runtime.
    return step.do(
      'agent-invoke',
      {
        // Conservative retry policy — the inner step rebuilds the agent
        // each attempt, so transient AI Gateway / DO blips replay
        // cleanly. Tools with side effects should rely on idempotency
        // keys (the queue transport pairs `tool_call_id` for that).
        retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
        timeout: '15 minutes',
      },
      async () => {
        // Dynamic imports break the static cycle:
        //   builder.ts → workflows/agent-workflow.ts → builder.ts
        // The workflow's `run` only executes at runtime, well after
        // both modules have finished loading.
        const [{ buildAgent }, { resolveManifest }, { compose }, contextMod] = await Promise.all([
          import('../manifests/builder'),
          import('../manifests/resolver'),
          import('../composition'),
          import('../context'),
        ]);
        const resolved = await resolveManifest(this.env, tenantId, manifestId);
        if (!resolved) {
          throw new Error(`manifest '${manifestId}' not found for tenant '${tenantId}'`);
        }
        // Force the inner build into transient mode so the underlying
        // pattern (react/deep/...) handles the loop directly. Without
        // this, the wrap would recursively spawn another workflow.
        const innerManifest = {
          ...resolved.manifest,
          spec: {
            ...resolved.manifest.spec,
            execution: { ...resolved.manifest.spec.execution, mode: 'transient' as const },
          },
        };
        const reqCtx = contextMod.buildAnonymousContext(this.env);
        reqCtx.auth = {
          ...reqCtx.auth,
          principal: { ...reqCtx.auth.principal, tenantId, subject: principalSubject },
        };
        try {
          const result = await contextMod.runWithContext(reqCtx, async () => {
            const agent = await buildAgent(innerManifest, {
              env: this.env,
              tools: compose(this.env),
            });
            return agent.invoke({ messages, ...(threadId ? { threadId } : {}) });
          });
          return JSON.stringify(result);
        } finally {
          contextMod.disposeLimitState(reqCtx.limitState);
        }
      },
    );
  }
}
