/**
 * Verifies the react loop renders prior session events through the
 * `SessionStrategy` and persists new events back to the session. We stub
 * the model so the test never reaches AI Gateway — just checks that:
 *
 *   1. Prior events are rendered into the messages the model sees.
 *   2. Each new user/assistant/tool turn is appended to the session.
 *   3. No persistence happens when `threadId` is omitted (empty-id
 *      session opened by the store is a no-op).
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import * as modelModule from '../../src/patterns/model';
import { buildReactAgent } from '../../src/patterns/react';
import type { ChatMessage } from '../../src/patterns/types';
import {
  type AppendableEvent,
  analyzeWake,
  type Session,
  type SessionEvent,
  type SessionStore,
} from '../../src/session/types';
import { defineTool } from '../../src/tools/types';

function ctx(): RequestContext {
  return { env: {} as Env, auth: ANONYMOUS, limitState: newLimitState() };
}

function fakeModel(responses: ChatMessage[]) {
  return {
    modelId: 'stub',
    route: { provider: 'anthropic', model: 'stub' } as const,
    async chat(messages: ChatMessage[]) {
      void messages;
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

interface RecordingStore extends SessionStore {
  opens: string[];
  appended: AppendableEvent[];
}

function recordingStore(initialPerThread: Record<string, SessionEvent[]> = {}): RecordingStore {
  const opens: string[] = [];
  const appended: AppendableEvent[] = [];
  return {
    opens,
    appended,
    open(threadId: string): Session {
      opens.push(threadId);
      const seed = initialPerThread[threadId] ?? [];
      const events: SessionEvent[] = [...seed];
      let nextSeq = events.length;
      const session: Session = {
        id: threadId,
        async getEvents() {
          return events.slice();
        },
        async head() {
          return { seq: nextSeq };
        },
        async append(ev) {
          appended.push(ev);
          events.push({ ...ev, seq: nextSeq, ts: ev.ts ?? Date.now() } as SessionEvent);
          nextSeq += 1;
        },
        async appendBatch(evs) {
          for (const ev of evs) {
            appended.push(ev);
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
      return session;
    },
  };
}

const echo = defineTool({
  name: 'echo',
  description: 'echo',
  args: z.object({ text: z.string() }),
  handler: async ({ text }) => text,
});

describe('react loop hydration', () => {
  it('hydrates events and persists new turns when threadId is set', async () => {
    const prior: SessionEvent[] = [
      { seq: 0, ts: 1, kind: 'message', role: 'user', content: 'earlier user turn' },
      { seq: 1, ts: 2, kind: 'message', role: 'assistant', content: 'earlier reply' },
    ];
    const store = recordingStore({ t: prior });
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(
      fakeModel([{ role: 'assistant', content: 'final answer' }]) as never,
    );
    const agent = buildReactAgent({
      env: {} as Env,
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
      tools: [echo],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      sessionStore: store,
    });
    await runWithContext(ctx(), async () => {
      const result = await agent.invoke({
        threadId: 't',
        messages: [{ role: 'user', content: 'hello' }],
      });
      // System + 2 prior + 1 new user + 1 model reply = 5
      expect(result.messages).toHaveLength(5);
      expect(result.messages[0]!.role).toBe('system');
      expect(result.messages[1]!.content).toBe('earlier user turn');
      expect(result.messages[3]!.content).toBe('hello');
      expect(result.final.content).toBe('final answer');
    });
    expect(store.opens).toEqual(['t']);
    // appended = the new user turn + the final assistant turn.
    expect(store.appended.map((e) => e.content)).toEqual(['hello', 'final answer']);
  });

  it('skips persistence when threadId is omitted', async () => {
    const store = recordingStore();
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(
      fakeModel([{ role: 'assistant', content: 'done' }]) as never,
    );
    const agent = buildReactAgent({
      env: {} as Env,
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
      tools: [echo],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      sessionStore: store,
    });
    await runWithContext(ctx(), async () => {
      await agent.invoke({ messages: [{ role: 'user', content: 'hi' }] });
    });
    expect(store.opens).toEqual(['']);
    expect(store.appended).toEqual([]);
  });

  it('persists every step of a tool-call cycle', async () => {
    const store = recordingStore();
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(
      fakeModel([
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'tc1', name: 'echo', args: { text: 'x' } }],
        },
        { role: 'assistant', content: 'final' },
      ]) as never,
    );
    const agent = buildReactAgent({
      env: {} as Env,
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
      tools: [echo],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      sessionStore: store,
    });
    await runWithContext(ctx(), async () => {
      await agent.invoke({
        threadId: 't2',
        messages: [{ role: 'user', content: 'go' }],
      });
    });
    // user + tool-calling assistant + tool result + final assistant
    expect(store.appended.map((e) => e.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(store.appended[2]!.tool_call_id).toBe('tc1');
  });
});
