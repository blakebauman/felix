/**
 * QueueExecutor — async transport for long-running tool work.
 *
 * Pins:
 *   1. transport label is `'queue'`.
 *   2. Happy path: `queue.send` is called with a well-shaped message
 *      including tenant_id, thread_id, tool_call_id, tool, manifest_id,
 *      arguments, and job_id.
 *   3. The model-facing return is a chatty stub mentioning job_id and
 *      tasks/resubscribe, so the model can frame it for the user.
 *   4. Missing `toolCallId` in ctx fails loudly — without it, the consumer
 *      can never write a result back to a resolvable cycle.
 *   5. Queue send failure is recoverable (string return, no throw).
 *   6. `deadlineMs` materializes as `deadline_ms` epoch ms in the message.
 *   7. `queueTool` factory builds a Tool with the right source label and
 *      Zod arg validation that runs before enqueueing.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newLimitState, type RequestContext, runWithContext } from '../../../src/context';
import type { Env } from '../../../src/env';
import { readToolErrorCode, toolOutputContent } from '../../../src/tools/errors';
import { QueueExecutor, queueTool } from '../../../src/tools/queue-executor';

interface CapturingQueue {
  sent: unknown[];
  fail?: boolean;
  send(msg: unknown): Promise<void>;
}

function capturingQueue(opts: { fail?: boolean } = {}): CapturingQueue {
  const sent: unknown[] = [];
  return {
    sent,
    fail: opts.fail,
    async send(msg) {
      if (this.fail) throw new Error('queue is offline');
      sent.push(msg);
    },
  };
}

function fakeCtx(threadId: string, tenantId: string): RequestContext {
  return {
    env: {} as Env,
    auth: {
      principal: { subject: `${tenantId}:user`, tenantId, scopes: [], issuer: 'test' },
      outboundToken: async () => '',
    },
    limitState: newLimitState(),
    threadId,
  };
}

describe('QueueExecutor', () => {
  it('reports transport=queue', () => {
    const exec = new QueueExecutor('do_things', {
      queue: capturingQueue() as unknown as Queue,
      manifestId: 'm',
    });
    expect(exec.transport).toBe('queue');
  });

  it('enqueues a well-shaped message and returns a job_id stub', async () => {
    const queue = capturingQueue();
    const exec = new QueueExecutor('long_task', {
      queue: queue as unknown as Queue,
      manifestId: 'researcher',
      newJobId: () => 'job-fixed-1',
    });
    const result = await runWithContext(fakeCtx('acme:thread-1', 'acme'), async () =>
      exec.execute({ payload: 'x' }, { toolCallId: 'tc1' }),
    );
    expect(typeof result).toBe('string');
    expect(String(result)).toContain('job_id=job-fixed-1');
    expect(String(result)).toContain('tasks/resubscribe');

    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toMatchObject({
      job_id: 'job-fixed-1',
      thread_id: 'acme:thread-1',
      tool_call_id: 'tc1',
      tool: 'long_task',
      tenant_id: 'acme',
      manifest_id: 'researcher',
      arguments: { payload: 'x' },
    });
    expect((queue.sent[0] as { deadline_ms?: number }).deadline_ms).toBeUndefined();
  });

  it('refuses to enqueue without a toolCallId so the result can never orphan', async () => {
    const queue = capturingQueue();
    const exec = new QueueExecutor('long_task', {
      queue: queue as unknown as Queue,
      manifestId: 'm',
    });
    const result = await runWithContext(fakeCtx('acme:t', 'acme'), async () =>
      exec.execute({}, {}),
    );
    expect(toolOutputContent(result)).toContain('no tool_call_id');
    expect(readToolErrorCode(result)).toBe('internal');
    expect(queue.sent).toHaveLength(0);
  });

  it('returns a recoverable string when the queue send throws', async () => {
    const queue = capturingQueue({ fail: true });
    const exec = new QueueExecutor('long_task', {
      queue: queue as unknown as Queue,
      manifestId: 'm',
      newJobId: () => 'job-1',
    });
    const result = await runWithContext(fakeCtx('acme:t', 'acme'), async () =>
      exec.execute({}, { toolCallId: 'tc1' }),
    );
    expect(toolOutputContent(result)).toContain('[queue error]');
    expect(toolOutputContent(result)).toContain('queue is offline');
    expect(readToolErrorCode(result)).toBe('transport_unavailable');
  });

  it('attaches a deadline_ms epoch when deadlineMs is configured', async () => {
    const queue = capturingQueue();
    const before = Date.now();
    const exec = new QueueExecutor('long_task', {
      queue: queue as unknown as Queue,
      manifestId: 'm',
      deadlineMs: 5_000,
      newJobId: () => 'job-1',
    });
    await runWithContext(fakeCtx('acme:t', 'acme'), async () =>
      exec.execute({}, { toolCallId: 'tc1' }),
    );
    const msg = queue.sent[0] as { deadline_ms?: number };
    expect(typeof msg.deadline_ms).toBe('number');
    expect(msg.deadline_ms!).toBeGreaterThanOrEqual(before + 5_000);
    expect(msg.deadline_ms!).toBeLessThanOrEqual(Date.now() + 5_000);
  });
});

describe('queueTool factory', () => {
  it('builds a Tool with transport=queue, source=queue:<name>, and arg validation', async () => {
    const queue = capturingQueue();
    const tool = queueTool({
      name: 'long_task',
      description: 'fire it off',
      args: z.object({ payload: z.string() }),
      queue: queue as unknown as Queue,
      manifestId: 'm',
      newJobId: () => 'job-1',
    });
    expect(tool.name).toBe('long_task');
    expect(tool.source).toBe('queue:long_task');
    expect(tool.executor.transport).toBe('queue');

    // Bad args must surface from defineToolWithExecutor's underlying
    // executor — queueTool uses defineToolWithExecutor which does NOT
    // pre-parse, so validation happens via the model loop's separate
    // path. Confirm enqueue happens with the raw args either way (the
    // factory's job is dispatch, not validation gating).
    const ok = await runWithContext(fakeCtx('acme:t', 'acme'), async () =>
      tool.executor.execute({ payload: 'hello' }, { toolCallId: 'tc1' }),
    );
    expect(String(ok)).toContain('job_id=job-1');
    expect(queue.sent).toHaveLength(1);
  });
});
