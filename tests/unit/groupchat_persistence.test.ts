/**
 * Groupchat persists transcripts through the same `SessionStore` the
 * react/deep loops use. This pins:
 *
 *   1. prior events are rendered when threadId is set,
 *   2. each speaker's reply (with `name`) is appended,
 *   3. children do NOT receive the threadId (parent owns the writes).
 */

import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { buildGroupchatAgent } from '../../src/patterns/groupchat';
import type { Agent, ChatMessage, InvokeInput } from '../../src/patterns/types';
import {
  type AppendableEvent,
  analyzeWake,
  type Session,
  type SessionEvent,
  type SessionStore,
} from '../../src/session/types';

function ctx(): RequestContext {
  return { env: {} as Env, auth: ANONYMOUS, limitState: newLimitState() };
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
      return {
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
    },
  };
}

function fixedReply(speaker: string, content: string): Agent & { calls: InvokeInput[] } {
  const calls: InvokeInput[] = [];
  return {
    tools: [],
    pattern: 'react',
    manifestId: speaker,
    manifestVersion: '1.0.0',
    async invoke(input: InvokeInput) {
      calls.push(input);
      const final: ChatMessage = { role: 'assistant', content };
      return { messages: [...input.messages, final], final };
    },
    async *streamEvents() {},
    calls,
  };
}

describe('groupchat persistence', () => {
  it('hydrates events, appends each speaker, and does not forward threadId', async () => {
    const prior: SessionEvent[] = [
      { seq: 0, ts: 1, kind: 'message', role: 'user', content: 'past turn' },
      { seq: 1, ts: 2, kind: 'message', role: 'assistant', content: 'past reply', name: 'alice' },
    ];
    const store = recordingStore({ g1: prior });
    const alice = fixedReply('alice', 'A1');
    const bob = fixedReply('bob', 'B1');
    const agent = buildGroupchatAgent({
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
      subAgents: { alice, bob },
      moderatorPrompt: 'mod',
      maxTurns: 2,
      manifestId: 'group',
      manifestVersion: '1.0.0',
      sessionStore: store,
    });
    const result = await runWithContext(ctx(), async () =>
      agent.invoke({
        threadId: 'g1',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    );
    expect(store.opens).toEqual(['g1']);
    // Appended: the new caller turn + 2 speaker replies.
    expect(store.appended.map((e) => e.content)).toEqual(['hello', 'A1', 'B1']);
    expect(store.appended[1]!.name).toBe('alice');
    expect(store.appended[2]!.name).toBe('bob');
    // Final transcript = prior history + new user + 2 replies.
    expect(result.messages).toHaveLength(prior.length + 1 + 2);
    // Children never see threadId — parent owns the writes.
    expect(alice.calls[0]!.threadId).toBeUndefined();
    expect(bob.calls[0]!.threadId).toBeUndefined();
  });
});
