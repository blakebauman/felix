/**
 * End-to-end queue path against real bindings:
 *
 *   1. Build a `QueueExecutor` bound to the live `JOBS_QUEUE` producer.
 *   2. Call `execute()` inside a RequestContext — this enqueues a real
 *      `QueueJobMessage` and returns the chatty stub the model sees.
 *   3. Inspect the assistant's `tool_call_id` view: write an assistant
 *      turn with the dispatched tool_call into a real `ConversationDO`
 *      and verify `session.wake()` reports it as pending.
 *   4. POST back through `/internal/sessions/:thread_id/events` with the
 *      shared secret. The endpoint forwards to ConversationDO and emits
 *      `queue_complete` server-side.
 *   5. `session.wake()` now reports the cycle resolved — the next model
 *      step would render the new `tool_result` through the strategy.
 *
 * This exercises every piece the queue transport touches in production:
 * `QueueExecutor` → live `Queue` binding → live `ConversationDO` writes
 * → `/internal` route → audit emission. Unit tests pin individual
 * contracts; this one pins they actually compose.
 */

import { env, SELF } from 'cloudflare:test';
import { ANONYMOUS } from '@felix/harness/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '@felix/harness/context';
import type { Env as AppEnv } from '@felix/harness/env';
import { conversationStub } from '@felix/harness/memory/conversation-do';
import { analyzeWake, type SessionEvent } from '@felix/harness/session/types';
import { QueueExecutor } from '@felix/harness/tools/queue-executor';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;
const SECRET = 'test-shared-secret';

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
});

async function readEvents(threadId: string): Promise<SessionEvent[]> {
  const resp = await conversationStub(testEnv, threadId).fetch('https://do/events');
  if (!resp.ok) return [];
  const data = (await resp.json()) as { events?: SessionEvent[] };
  return data.events ?? [];
}

async function seedAssistantWithToolCall(
  threadId: string,
  toolCallId: string,
  toolName: string,
): Promise<void> {
  await conversationStub(testEnv, threadId).fetch('https://do/events', {
    method: 'POST',
    body: JSON.stringify({
      events: [
        { kind: 'message', role: 'user', content: 'kick off' },
        {
          kind: 'message',
          role: 'assistant',
          content: '',
          tool_calls: [{ id: toolCallId, name: toolName, args: { payload: 'work' } }],
        },
      ],
    }),
  });
}

describe('queue transport end-to-end', () => {
  it('dispatches via QueueExecutor, lands via /internal, resolves via wake()', async () => {
    const threadId = 'acme:queue-e2e-1';
    const toolCallId = 'tc-e2e-1';

    // 1. Seed the assistant turn that dispatched the tool. This is what
    // the react loop would persist before/around the executor call.
    await seedAssistantWithToolCall(threadId, toolCallId, 'long_research');

    // Pre-dispatch: wake() should already see the unresolved tool_call.
    const wakeBefore = analyzeWake(await readEvents(threadId));
    expect(wakeBefore.pendingToolCalls.map((c) => c.id)).toEqual([toolCallId]);

    // 2. Dispatch via the real Queue producer. The send actually goes
    // through to miniflare's queue — there's no consumer attached in
    // this test, which is correct: the test plays the consumer role.
    const ctx: RequestContext = {
      env: testEnv,
      auth: { ...ANONYMOUS, principal: { ...ANONYMOUS.principal, tenantId: 'acme' } },
      limitState: newLimitState(),
      threadId,
    };
    const exec = new QueueExecutor('long_research', {
      queue: (testEnv as unknown as { JOBS_QUEUE: Queue }).JOBS_QUEUE,
      manifestId: 'researcher',
      newJobId: () => 'job-e2e-1',
    });
    const stub = await runWithContext(ctx, async () =>
      exec.execute({ payload: 'work' }, { toolCallId }),
    );
    expect(String(stub)).toContain('job_id=job-e2e-1');
    expect(String(stub)).toContain('tasks/resubscribe');

    // 2b. The write-back route pairs the inbound tool_result to an
    // outstanding `queue_dispatch` audit row before it lands anything. That
    // row is emitted through AUDIT_QUEUE and batched into D1 asynchronously;
    // in production it is long settled by the time a long-running job
    // completes. Land it synchronously here so the dispatch-pairing check
    // sees it (simulates the audit consumer having flushed the dispatch row).
    await testEnv.DB.prepare(
      `INSERT INTO audit_events
         (id, tenant_id, ts, event_type, manifest_id, principal_subj, status, payload_json)
         VALUES (?, 'acme', ?, 'queue_dispatch', 'researcher', '', 'enqueued', ?)`,
    )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        JSON.stringify({
          job_id: 'job-e2e-1',
          tool: 'long_research',
          tool_call_id: toolCallId,
          thread_id: threadId,
        }),
      )
      .run();

    // 3. Consumer arrives — POST the `tool_result` through the internal
    // endpoint with the shared secret. This is exactly what the
    // examples/queue-consumer Worker does in production.
    const writeback = await SELF.fetch(
      `https://orchestrator.test/internal/sessions/${encodeURIComponent(threadId)}/events`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-consumer-secret': SECRET,
        },
        body: JSON.stringify({
          events: [
            {
              kind: 'tool_result',
              tool_call_id: toolCallId,
              name: 'long_research',
              content: '[done] processed work',
              metadata: { job_id: 'job-e2e-1', source: 'queue-consumer' },
            },
          ],
        }),
      },
    );
    expect(writeback.status).toBe(200);
    const writebackBody = (await writeback.json()) as { ok: boolean; written: number };
    expect(writebackBody).toEqual({ ok: true, written: 1 });

    // 4. The session log now contains the tool_result keyed to tc1.
    const events = await readEvents(threadId);
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({
      kind: 'tool_result',
      tool_call_id: toolCallId,
      content: '[done] processed work',
    });

    // 5. wake() reports the cycle resolved. A reconnecting client would
    // see this through tasks/resubscribe and the next model step would
    // render the resolved tool_result through the SessionStrategy.
    const wakeAfter = analyzeWake(events);
    expect(wakeAfter.pendingToolCalls).toEqual([]);
  });

  it('rejects internal write-back with a wrong shared secret (auth floor)', async () => {
    const resp = await SELF.fetch(
      'https://orchestrator.test/internal/sessions/acme:thread-x/events',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-consumer-secret': 'wrong-secret',
        },
        body: JSON.stringify({
          events: [
            {
              kind: 'tool_result',
              tool_call_id: 'tc1',
              name: 'long_research',
              content: '[malicious] would have written',
            },
          ],
        }),
      },
    );
    expect(resp.status).toBe(401);
  });

  it('rejects non-tool_result events even with a valid secret (defense in depth)', async () => {
    const resp = await SELF.fetch(
      'https://orchestrator.test/internal/sessions/acme:thread-x/events',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-consumer-secret': SECRET,
        },
        body: JSON.stringify({
          events: [{ kind: 'message', role: 'user', content: 'should be rejected' }],
        }),
      },
    );
    expect(resp.status).toBe(400);
  });

  it('rejects a validly-authenticated write-back with no paired dispatch (409, writes nothing)', async () => {
    // A holder of the shared secret with a valid-shaped tool_result but no
    // matching `queue_dispatch` row must be rejected — this is the H4
    // integrity floor. It also stands in for the cross-tenant case: a forged
    // thread prefix resolves to a tenant with no dispatch for the id.
    const threadId = 'acme:forged-thread';
    const resp = await SELF.fetch(
      `https://orchestrator.test/internal/sessions/${encodeURIComponent(threadId)}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-consumer-secret': SECRET },
        body: JSON.stringify({
          events: [
            {
              kind: 'tool_result',
              tool_call_id: 'never-dispatched',
              name: 'long_research',
              content: '[malicious] would have written',
            },
          ],
        }),
      },
    );
    expect(resp.status).toBe(409);

    // Nothing landed on the forged thread.
    const events = await readEvents(threadId);
    expect(events).toEqual([]);
  });
});
