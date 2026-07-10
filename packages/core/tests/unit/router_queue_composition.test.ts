/**
 * router → queue composition.
 *
 * Queues are forbidden on multi-agent patterns themselves, but their
 * leaf children (`pattern: react`) can declare queue tools. This test
 * verifies that the threadId actually reaches the QueueExecutor under
 * router → react dispatch — without it, the consumer can't write a
 * `tool_result` back to a resolvable cycle.
 *
 * Pins:
 *   1. Router forwards `input.threadId` to its chosen child.
 *   2. React passes it through to the executor as `ToolInvocationCtx.threadId`.
 *   3. QueueExecutor reads the pattern-scoped threadId (not the global
 *      RequestContext.threadId, which is empty for direct agent.invoke
 *      callers in tests and even in production routes that don't write it).
 *   4. The enqueued message carries `thread_id` matching what the caller
 *      provided — so the consumer write-back lands on the right session.
 *   5. Parallel (which strips threadId) causes QueueExecutor to refuse
 *      the enqueue with a clear error — async work without a session
 *      can't be paired back.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import * as modelModule from '../../src/patterns/model';
import { buildReactAgent } from '../../src/patterns/react';
import { buildRouterAgent } from '../../src/patterns/router';
import type { ChatMessage } from '../../src/patterns/types';
import { QueueExecutor, queueTool } from '../../src/tools/queue-executor';

function fakeEnv(): Env {
  return {
    MODEL_ROUTES: JSON.stringify({
      'claude-sonnet-4': { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
    }),
    DEFAULT_MODEL_ID: 'claude-sonnet-4',
    ENVIRONMENT: 'development',
  } as unknown as Env;
}

function reqCtx(): RequestContext {
  // Note: no `threadId` field. Production routes don't write it either —
  // the pattern-scoped path through ToolInvocationCtx is what carries it.
  return {
    env: fakeEnv(),
    auth: { ...ANONYMOUS, principal: { ...ANONYMOUS.principal, tenantId: 'acme' } },
    limitState: newLimitState(),
  };
}

function fakeModel(responses: ChatMessage[]) {
  return {
    modelId: 'stub',
    route: { provider: 'anthropic', model: 'stub' } as const,
    async chat(_msgs: ChatMessage[]) {
      const next = responses.shift();
      if (!next) throw new Error('out of stubbed responses');
      const stopReason = next.tool_calls?.length ? 'tool_use' : 'end_turn';
      return { message: next, stopReason: stopReason as 'tool_use' | 'end_turn' };
    },
    async *streamChat() {
      // no-op
    },
  };
}

describe('router → queue composition', () => {
  it('forwards threadId from router down to QueueExecutor', async () => {
    const sent: Array<{ thread_id: string; tool: string; tool_call_id: string }> = [];
    const queue = {
      async send(msg: { thread_id: string; tool: string; tool_call_id: string }) {
        sent.push(msg);
      },
    } as unknown as Queue;

    // The classifier picks 'workerA'; that child has the queue tool.
    vi.spyOn(modelModule, 'buildModel').mockImplementation((_env, spec) => {
      // First buildModel call is the router classifier (one chat call:
      // returns 'workerA'). Second is workerA's react loop (one chat
      // call: emits a tool_call to long_task).
      if (spec.id === 'router-model') {
        return fakeModel([{ role: 'assistant', content: 'workerA' }]) as never;
      }
      return fakeModel([
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'tc-router-1', name: 'long_task', args: { payload: 'x' } }],
        },
        { role: 'assistant', content: 'will arrive on next turn' },
      ]) as never;
    });

    const workerA = buildReactAgent({
      env: fakeEnv(),
      modelSpec: {
        id: 'worker-model',
        temperature: 0,
        max_tokens: null,
        region: null,
        cache: false,
        thinking_budget: null,
        fallbacks: [],
        confidence_escalation: {
          enabled: false,
          escalate_to: '',
          low_confidence_markers: [],
          min_response_chars: 40,
        },
      },
      tools: [
        queueTool({
          name: 'long_task',
          description: '',
          args: z.object({ payload: z.string() }),
          queue,
          manifestId: 'workerA',
          newJobId: () => 'job-r1',
        }),
      ],
      systemPrompt: 'sp',
      manifestId: 'workerA',
      manifestVersion: '1.0.0',
    });

    const router = buildRouterAgent({
      env: fakeEnv(),
      modelSpec: {
        id: 'router-model',
        temperature: 0,
        max_tokens: null,
        region: null,
        cache: false,
        thinking_budget: null,
        fallbacks: [],
        confidence_escalation: {
          enabled: false,
          escalate_to: '',
          low_confidence_markers: [],
          min_response_chars: 40,
        },
      },
      subAgents: { workerA },
      classifierPrompt: 'pick one',
      manifestId: 'router',
      manifestVersion: '1.0.0',
    });

    await runWithContext(reqCtx(), async () => {
      await router.invoke({
        threadId: 'acme:routed-thread-1',
        messages: [{ role: 'user', content: 'do the long task' }],
      });
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      thread_id: 'acme:routed-thread-1',
      tool: 'long_task',
      tool_call_id: 'tc-router-1',
    });
  });

  it('refuses to enqueue when a child is invoked without a threadId (parallel strip case)', async () => {
    // Parallel strips `threadId` from its children before invoking them
    // (children are stateless for the parallel run; sharing a threadId
    // would race-write the same DO). We simulate that by invoking the
    // child react agent directly with `threadId` undefined and asserting
    // the queue executor refused.
    const sent: unknown[] = [];
    const queue = {
      async send(msg: unknown) {
        sent.push(msg);
      },
    } as unknown as Queue;

    vi.spyOn(modelModule, 'buildModel').mockImplementation(
      () =>
        fakeModel([
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'tc-par-1', name: 'long_task', args: {} }],
          },
          { role: 'assistant', content: 'final reply to user' },
        ]) as never,
    );

    const workerA = buildReactAgent({
      env: fakeEnv(),
      modelSpec: {
        id: null,
        temperature: 0,
        max_tokens: null,
        region: null,
        cache: false,
        thinking_budget: null,
        fallbacks: [],
        confidence_escalation: {
          enabled: false,
          escalate_to: '',
          low_confidence_markers: [],
          min_response_chars: 40,
        },
      },
      tools: [
        queueTool({
          name: 'long_task',
          description: '',
          args: z.object({}).strict(),
          queue,
          manifestId: 'workerA',
          newJobId: () => 'job-par-1',
        }),
      ],
      systemPrompt: 'sp',
      manifestId: 'workerA',
      manifestVersion: '1.0.0',
    });

    const result = await runWithContext(reqCtx(), async () =>
      // Note: NO threadId passed — this is exactly what parallel does.
      workerA.invoke({ messages: [{ role: 'user', content: 'spawn' }] }),
    );

    // The queue should never have been sent to.
    expect(sent).toHaveLength(0);
    // The model saw the refusal string as the tool_result on the next turn.
    const toolResult = result.messages.find((m) => m.role === 'tool');
    expect(toolResult).toBeDefined();
    expect(String(toolResult!.content)).toContain('[queue error]');
    expect(String(toolResult!.content)).toContain('no thread_id');
  });

  it('QueueExecutor prefers ToolInvocationCtx.threadId over RequestContext.threadId', async () => {
    // RequestContext.threadId is set to one value, ToolInvocationCtx.threadId
    // to another — the pattern-scoped one wins. This is what lets parallel
    // strip its children's threadId without their queue tools accidentally
    // falling back to the parent's session.
    const sent: Array<{ thread_id: string }> = [];
    const queue = {
      async send(msg: { thread_id: string }) {
        sent.push(msg);
      },
    } as unknown as Queue;
    const exec = new QueueExecutor('long_task', {
      queue,
      manifestId: 'm',
      newJobId: () => 'job-pref-1',
    });
    const ctx: RequestContext = {
      env: fakeEnv(),
      auth: { ...ANONYMOUS, principal: { ...ANONYMOUS.principal, tenantId: 'acme' } },
      limitState: newLimitState(),
      threadId: 'acme:from-request-ctx',
    };
    await runWithContext(ctx, async () =>
      exec.execute({}, { toolCallId: 'tc1', threadId: 'acme:from-tool-ctx' }),
    );
    expect(sent[0]!.thread_id).toBe('acme:from-tool-ctx');
  });
});
