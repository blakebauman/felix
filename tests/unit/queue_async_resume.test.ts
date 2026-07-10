/**
 * Async-resume protocol — end-to-end across the seams it depends on:
 *
 *   1. Model emits an assistant turn with a tool_call.
 *   2. `QueueExecutor.execute` enqueues a job carrying tool_call_id +
 *      thread_id, returns a chatty stub.
 *   3. A consumer (fake here) processes the job and writes a
 *      `tool_result` event back to the session keyed to the same
 *      tool_call_id.
 *   4. `session.wake()` after the consumer has landed shows the cycle
 *      resolved (no `pendingToolCalls`) — confirming that
 *      `tasks/resubscribe` would deliver the result and the next model
 *      step picks it up naturally.
 *
 * The test is intentionally infrastructure-light: an in-memory session
 * and an in-memory queue stand in for `ConversationDO` and the real
 * `Queue` binding. The point is to pin the protocol, not the bindings.
 */

import { describe, expect, it } from 'vitest';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import {
  type AppendableEvent,
  analyzeWake,
  type Session,
  type SessionEvent,
} from '../../src/session/types';
import { QueueExecutor, type QueueJobMessage } from '../../src/tools/queue-executor';

function mutableSession(initial: SessionEvent[] = []): Session {
  const events = [...initial];
  let nextSeq = events.length;
  return {
    id: 'thread-1',
    async getEvents() {
      return events.slice();
    },
    async head() {
      return { seq: nextSeq };
    },
    async append(ev: AppendableEvent) {
      events.push({ ...ev, seq: nextSeq, ts: ev.ts ?? Date.now() } as SessionEvent);
      nextSeq += 1;
    },
    async appendBatch(evs) {
      for (const ev of evs) {
        events.push({ ...ev, seq: nextSeq, ts: ev.ts ?? Date.now() } as SessionEvent);
        nextSeq += 1;
      }
    },
    async reset() {
      events.length = 0;
      nextSeq = 0;
    },
    async wake() {
      return analyzeWake(events.slice());
    },
  };
}

function reqCtx(threadId: string, tenantId: string): RequestContext {
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

describe('async resume protocol', () => {
  it('enqueues, consumer writes tool_result, wake() reports a resolved cycle', async () => {
    // 1. Model emitted an assistant turn with one tool_call.
    const session = mutableSession();
    await session.append({ kind: 'message', role: 'user', content: 'kick off the long task' });
    await session.append({
      kind: 'message',
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc1', name: 'long_task', args: { payload: 'work' } }],
    });

    // First wake() — before the consumer has landed anything — should
    // report tc1 as still pending.
    const wakeBefore = await session.wake();
    expect(wakeBefore.fresh).toBe(false);
    expect(wakeBefore.pendingToolCalls.map((c) => c.id)).toEqual(['tc1']);

    // 2. Executor enqueues a job carrying tool_call_id + thread_id.
    const sent: QueueJobMessage[] = [];
    const queue = {
      async send(msg: QueueJobMessage) {
        sent.push(msg);
      },
    } as unknown as Queue;
    const exec = new QueueExecutor('long_task', {
      queue,
      manifestId: 'researcher',
      newJobId: () => 'job-42',
    });
    const stub = await runWithContext(reqCtx('thread-1', 'acme'), async () =>
      exec.execute({ payload: 'work' }, { toolCallId: 'tc1' }),
    );
    expect(String(stub)).toContain('job_id=job-42');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      job_id: 'job-42',
      tool_call_id: 'tc1',
      thread_id: 'thread-1',
      tool: 'long_task',
      arguments: { payload: 'work' },
    });

    // 3. The fake "consumer" — in reality this would be a separate
    // Worker / queue consumer — processes the job and writes a
    // tool_result back to the session keyed to the same tool_call_id.
    const job = sent[0]!;
    const result = `[done] processed ${(job.arguments as { payload: string }).payload}`;
    await session.append({
      kind: 'tool_result',
      role: 'tool',
      tool_call_id: job.tool_call_id,
      name: job.tool,
      content: result,
    });

    // 4. wake() now reports the cycle as resolved. A reconnecting client
    // issuing tasks/resubscribe would see no pending tool calls, and
    // the next model step on this thread would render the resolved
    // tool_result back into the working set.
    const wakeAfter = await session.wake();
    expect(wakeAfter.pendingToolCalls).toEqual([]);
    expect(wakeAfter.endedOnAssistant).toBe(false);
    // The last event is the tool_result we just wrote; the next model
    // call will see it via the SessionStrategy.
    const events = await session.getEvents();
    expect(events[events.length - 1]).toMatchObject({
      kind: 'tool_result',
      tool_call_id: 'tc1',
      content: result,
    });
  });

  it('multiple parallel queued tool_calls resolve independently', async () => {
    const session = mutableSession();
    await session.append({
      kind: 'message',
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'tc1', name: 'long_task', args: { n: 1 } },
        { id: 'tc2', name: 'long_task', args: { n: 2 } },
      ],
    });

    // Both pending up-front.
    expect((await session.wake()).pendingToolCalls.map((c) => c.id).sort()).toEqual(['tc1', 'tc2']);

    // Consumer lands tc2 first.
    await session.append({
      kind: 'tool_result',
      role: 'tool',
      tool_call_id: 'tc2',
      name: 'long_task',
      content: 'done-2',
    });
    expect((await session.wake()).pendingToolCalls.map((c) => c.id)).toEqual(['tc1']);

    // Then tc1.
    await session.append({
      kind: 'tool_result',
      role: 'tool',
      tool_call_id: 'tc1',
      name: 'long_task',
      content: 'done-1',
    });
    expect((await session.wake()).pendingToolCalls).toEqual([]);
  });
});
