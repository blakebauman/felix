/**
 * plan_execute persists the PARENT transcript through the same
 * `SessionStore` react/reflect use, so multi-turn conversations keep their
 * history instead of silently forgetting. This pins:
 *
 *   1. the parent thread is opened and the new caller turn + synthesized
 *      answer are appended,
 *   2. events accumulate across two invokes on the same threadId,
 *   3. the second turn's planner call is fed the prior conversation as
 *      context (multi-turn actually works, not just persists).
 *
 * The executor sub-loops stay stateless (they run without a threadId), so
 * their tool chatter never lands on the parent thread.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import type { Manifest, Model } from '../../src/manifests/schema';
import * as modelModule from '../../src/patterns/model';
import { buildPlanExecuteAgent } from '../../src/patterns/plan-execute';
import * as reactModule from '../../src/patterns/react';
import type { Agent, ChatMessage, InvokeInput, InvokeResult } from '../../src/patterns/types';
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

const PLAN_EXECUTE_OPTS = {
  planner_model: '',
  executor_model: '',
  max_subtasks: 5,
  replan_on_failure: true,
  max_replans: 2,
  executor_recursion_limit: 4,
  planner_few_shots: 0,
};

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
  // Persist per-thread events ACROSS open() calls so a second invocation on
  // the same threadId hydrates the first turn's history (real DO behavior).
  const threads = new Map<string, SessionEvent[]>();
  return {
    opens,
    appended,
    open(threadId: string): Session {
      opens.push(threadId);
      if (!threads.has(threadId)) threads.set(threadId, [...(initialPerThread[threadId] ?? [])]);
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

function fakeExecutor(replies: string[]): Agent {
  return {
    tools: [],
    pattern: 'react',
    manifestId: 'fake',
    manifestVersion: '1.0.0',
    async invoke(input: InvokeInput): Promise<InvokeResult> {
      const reply = replies.shift() ?? 'no more replies';
      const final: ChatMessage = { role: 'assistant', content: reply };
      return { messages: [...input.messages, final], final };
    },
    async *streamEvents() {},
  };
}

/**
 * Planner/synthesizer stub that records every `chat` message array so the
 * test can assert the second turn saw prior conversation context.
 */
function fakeModel(replies: string[], captured: ChatMessage[][]) {
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

function buildArgs(): Parameters<typeof buildPlanExecuteAgent>[0] {
  return {
    env: {} as Env,
    manifest: {
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'test', version: '1.0.0' },
      spec: {
        procedural_memory: { enabled: false, top_k: 3, embedding_model: 'bge' },
      },
    } as unknown as Manifest,
    modelSpec: MODEL_SPEC,
    tools: [],
    systemPrompt: 'sp',
    manifestId: 'test',
    manifestVersion: '1.0.0',
    primaryModel: MODEL_SPEC,
    planExecute: PLAN_EXECUTE_OPTS,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('plan_execute parent-thread persistence', () => {
  it('persists caller turn + synthesized answer and hydrates prior context across turns', async () => {
    const store = recordingStore();
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(fakeExecutor(['did s1', 'did s1 v2']));
    const captured: ChatMessage[][] = [];
    const planner = fakeModel(
      [
        '{"plan":[{"id":"s1","description":"do it"}]}', // turn 1 planner
        'Answer to the first ask.', // turn 1 synthesis
        '{"plan":[{"id":"s1","description":"do it again"}]}', // turn 2 planner
        'Answer to the second ask.', // turn 2 synthesis
      ],
      captured,
    );
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(planner as never);

    const args = buildArgs();
    args.sessionStore = store;
    const agent = buildPlanExecuteAgent(args);

    const r1 = await runWithContext(ctx(), () =>
      agent.invoke({ threadId: 'p1', messages: [{ role: 'user', content: 'first ask' }] }),
    );
    expect(r1.final.content).toBe('Answer to the first ask.');
    expect(store.opens).toContain('p1');
    const contentsAfter1 = store.appended.map((e) => e.content);
    expect(contentsAfter1).toContain('first ask');
    expect(contentsAfter1).toContain('Answer to the first ask.');
    const afterTurn1 = store.appended.length;

    const r2 = await runWithContext(ctx(), () =>
      agent.invoke({ threadId: 'p1', messages: [{ role: 'user', content: 'second ask' }] }),
    );
    expect(r2.final.content).toBe('Answer to the second ask.');
    // Events accumulated — the thread was not reset between turns.
    expect(store.appended.length).toBeGreaterThan(afterTurn1);
    const contentsAfter2 = store.appended.map((e) => e.content);
    expect(contentsAfter2).toContain('second ask');
    expect(contentsAfter2).toContain('Answer to the second ask.');

    // Turn-2 planner (captured[2]) saw the prior conversation as context.
    const turn2Planner = captured[2]!.map((m) => m.content).join('\n');
    expect(turn2Planner).toContain('first ask');
    expect(turn2Planner).toContain('Answer to the first ask.');
  });

  it('does not open a thread when no threadId is supplied (stateless)', async () => {
    const store = recordingStore();
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(fakeExecutor(['did s1']));
    const captured: ChatMessage[][] = [];
    const planner = fakeModel(
      ['{"plan":[{"id":"s1","description":"do it"}]}', 'stateless answer'],
      captured,
    );
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(planner as never);

    const args = buildArgs();
    args.sessionStore = store;
    const agent = buildPlanExecuteAgent(args);

    const r = await runWithContext(ctx(), () =>
      agent.invoke({ messages: [{ role: 'user', content: 'one shot' }] }),
    );
    expect(r.final.content).toBe('stateless answer');
    // open('') is called but its NoopSession-equivalent (empty id) persists nothing.
    expect(store.appended).toHaveLength(0);
  });
});
