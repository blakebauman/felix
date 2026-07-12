/**
 * parallel persists the PARENT aggregator's transcript through the same
 * `SessionStore` react/groupchat use, so a multi-turn `parallel` manifest
 * with a real checkpointer keeps its history instead of silently forgetting.
 * This pins:
 *
 *   1. the parent thread is opened; the new caller turn + synthesized answer
 *      are appended,
 *   2. events accumulate across two invokes on the same threadId,
 *   3. children are fanned the hydrated transcript but NEVER receive the
 *      threadId (they must not race-write the parent's ConversationDO).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import type { Model } from '../../src/manifests/schema';
import * as modelModule from '../../src/patterns/model';
import { buildParallelAgent } from '../../src/patterns/parallel';
import type { Agent, ChatMessage, InvokeInput } from '../../src/patterns/types';
import {
  type AppendableEvent,
  analyzeWake,
  type Session,
  type SessionEvent,
  type SessionStore,
} from '../../src/session/types';

const MODEL_SPEC: Model = {
  id: null,
  temperature: 0,
  max_tokens: null,
  region: null,
  cache: false,
  thinking_budget: null,
  fallbacks: [] as string[],
  confidence_escalation: {
    enabled: false,
    escalate_to: '',
    low_confidence_markers: [],
    min_response_chars: 40,
  },
};

function ctx(): RequestContext {
  return { env: {} as Env, auth: ANONYMOUS, limitState: newLimitState() };
}

interface RecordingStore extends SessionStore {
  opens: string[];
  appended: AppendableEvent[];
}

function recordingStore(): RecordingStore {
  const opens: string[] = [];
  const appended: AppendableEvent[] = [];
  // Persist per-thread events ACROSS open() calls so a second invocation on
  // the same threadId hydrates the first turn's history (real DO behavior).
  const threads = new Map<string, SessionEvent[]>();
  return {
    opens,
    appended,
    open(threadId: string): Session {
      opens.push(threadId);
      if (!threads.has(threadId)) threads.set(threadId, []);
      const events = threads.get(threadId)!;
      return {
        id: threadId,
        async getEvents() {
          return events.slice();
        },
        async head() {
          return { seq: events.length };
        },
        async append(ev) {
          appended.push(ev);
          events.push({ ...ev, seq: events.length, ts: ev.ts ?? Date.now() } as SessionEvent);
        },
        async appendBatch(evs) {
          for (const ev of evs) {
            appended.push(ev);
            events.push({ ...ev, seq: events.length, ts: ev.ts ?? Date.now() } as SessionEvent);
          }
        },
        async reset() {
          events.length = 0;
        },
        async wake() {
          return analyzeWake(events.slice());
        },
      };
    },
  };
}

function fixedReply(content: string): Agent & { calls: InvokeInput[] } {
  const calls: InvokeInput[] = [];
  return {
    tools: [],
    pattern: 'react',
    manifestId: 'child',
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

function fakeAggregator(replies: string[], captured: ChatMessage[][]) {
  return {
    modelId: 'fake',
    route: { provider: 'fake', model: 'fake' } as const,
    async chat(messages: ChatMessage[]) {
      captured.push(messages);
      const content = replies.shift() ?? '';
      return {
        message: { role: 'assistant' as const, content },
        stopReason: 'end_turn' as const,
      };
    },
    async *streamChat() {
      yield '';
      return {
        message: { role: 'assistant' as const, content: '' },
        stopReason: 'end_turn' as const,
      };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parallel parent-thread persistence', () => {
  it('persists the aggregated answer, accumulates across turns, and withholds threadId', async () => {
    const store = recordingStore();
    const captured: ChatMessage[][] = [];
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(
      fakeAggregator(['synth-1', 'synth-2'], captured) as never,
    );
    const alice = fixedReply('A');
    const bob = fixedReply('B');
    const agent = buildParallelAgent({
      env: {} as Env,
      modelSpec: MODEL_SPEC,
      subAgents: { alice, bob },
      aggregatorPrompt: 'agg',
      manifestId: 'par',
      manifestVersion: '1.0.0',
      sessionStore: store,
    });

    const r1 = await runWithContext(ctx(), () =>
      agent.invoke({ threadId: 'par1', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(r1.final.content).toBe('synth-1');
    expect(store.opens).toContain('par1');
    const after1 = store.appended.map((e) => e.content);
    expect(after1).toContain('hi');
    expect(after1).toContain('synth-1');
    // Children never see the threadId — parent owns the writes.
    expect(alice.calls[0]!.threadId).toBeUndefined();
    expect(bob.calls[0]!.threadId).toBeUndefined();
    const afterTurn1 = store.appended.length;

    const r2 = await runWithContext(ctx(), () =>
      agent.invoke({ threadId: 'par1', messages: [{ role: 'user', content: 'again' }] }),
    );
    expect(r2.final.content).toBe('synth-2');
    expect(store.appended.length).toBeGreaterThan(afterTurn1);
    const after2 = store.appended.map((e) => e.content);
    expect(after2).toContain('again');
    expect(after2).toContain('synth-2');

    // Turn-2 children were fanned the hydrated prior transcript.
    const turn2Child = alice.calls[1]!.messages.map((m) => m.content);
    expect(turn2Child).toContain('hi');
    expect(turn2Child).toContain('synth-1');
    expect(alice.calls[1]!.threadId).toBeUndefined();
  });
});
