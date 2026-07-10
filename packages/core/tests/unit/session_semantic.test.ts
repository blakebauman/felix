/**
 * SemanticRetrievalStrategycontext-engineering primitive.
 *
 * Pins:
 *   1. Under topK events → renders everything (no embedding needed).
 *   2. With no AI binding → degrades to a windowed-K tail.
 *   3. With AI present → ranks by cosine similarity; top-K by score.
 *   4. Pinned events always render regardless of similarity score.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import * as metricsModule from '../../src/observability/metrics';
import { makeSemanticRetrievalSessionStrategy } from '../../src/session/semantic-strategy';
import type { Session, SessionEvent } from '../../src/session/types';

afterEach(() => {
  vi.restoreAllMocks();
});

function ev(seq: number, content: string, pinned = false): SessionEvent {
  return {
    seq,
    ts: 0,
    kind: 'message',
    role: 'user',
    content,
    ...(pinned ? { metadata: { pinned: true } } : {}),
  };
}

function fakeSession(events: SessionEvent[]): Session {
  return {
    id: 'thr',
    async getEvents() {
      return events;
    },
    async head() {
      return { seq: events.length };
    },
    async append() {},
    async appendBatch() {},
    async reset() {},
    async wake() {
      return {
        fresh: false,
        headSeq: events.length,
        pendingToolCalls: [],
        endedOnAssistant: false,
      };
    },
  };
}

/** Embedding stub: emits a vector whose first component equals the
 *  count of the letter 'a' in the text. Pure noise otherwise. This
 *  lets the test rig assert "higher 'a' density → higher similarity". */
function aiStub() {
  return {
    async run(_model: string, input: { text: string[] }) {
      return {
        data: input.text.map((t) => {
          const a = (t.match(/a/g) ?? []).length;
          return [a, 1, 0, 0, 0];
        }),
      };
    },
  };
}

function makeCtx(env: Env): RequestContext {
  return { env, auth: ANONYMOUS, limitState: newLimitState() };
}

describe('SemanticRetrievalStrategy', () => {
  it('renders all events when count ≤ topK (no embedding required)', async () => {
    const strategy = makeSemanticRetrievalSessionStrategy(10);
    const events = [ev(0, 'one'), ev(1, 'two')];
    const env = {} as unknown as Env;
    const rendered = await runWithContext(makeCtx(env), () =>
      strategy.render(fakeSession(events), [], { systemPrompt: 'sp' }),
    );
    expect(rendered.length).toBe(3); // system + 2 events
  });

  it('degrades to windowed-K tail when env.AI is absent', async () => {
    const strategy = makeSemanticRetrievalSessionStrategy(2);
    const events = [ev(0, 'one'), ev(1, 'two'), ev(2, 'three'), ev(3, 'four')];
    const env = {} as unknown as Env;
    const rendered = await runWithContext(makeCtx(env), () =>
      strategy.render(fakeSession(events), [{ role: 'user', content: 'go' }], {
        systemPrompt: 'sp',
      }),
    );
    expect(rendered.length).toBe(4); // system + last 2 + incoming
    expect(rendered.slice(1, 3).map((m) => m.content)).toEqual(['three', 'four']);
  });

  it('picks the top-K most similar events when AI is wired', async () => {
    const strategy = makeSemanticRetrievalSessionStrategy(2);
    const events = [
      ev(0, 'banana banana banana'), // a-count 6, similar to query
      ev(1, 'one'), // a-count 0
      ev(2, 'aaaa'), // a-count 4
      ev(3, 'no letters here at all'), // a-count 3
    ];
    const env = { AI: aiStub() } as unknown as Env;
    const rendered = await runWithContext(makeCtx(env), () =>
      strategy.render(fakeSession(events), [{ role: 'user', content: 'aaaaaa' }], {
        systemPrompt: 'sp',
      }),
    );
    // Expect the two highest-a events: 'banana banana banana' (6) and 'aaaa' (4)
    // Rendered in seq order: 0 then 2.
    const contents = rendered.slice(1, -1).map((m) => m.content);
    expect(contents).toEqual(['banana banana banana', 'aaaa']);
  });

  it('degrades to windowed AND emits a counter when embedding throws', async () => {
    const counters: string[] = [];
    vi.spyOn(metricsModule, 'recordCounter').mockImplementation((name) => {
      counters.push(name);
    });
    const strategy = makeSemanticRetrievalSessionStrategy(2);
    const events = [ev(0, 'one'), ev(1, 'two'), ev(2, 'three'), ev(3, 'four')];
    const brokenAi = {
      async run() {
        throw new Error('workers ai down');
      },
    };
    const env = { AI: brokenAi } as unknown as Env;
    const rendered = await runWithContext(makeCtx(env), () =>
      strategy.render(fakeSession(events), [{ role: 'user', content: 'go' }], {
        systemPrompt: 'sp',
      }),
    );
    // Fell back to the last-2 window.
    expect(rendered.slice(1, 3).map((m) => m.content)).toEqual(['three', 'four']);
    expect(counters).toContain('orchestrator_semantic_retrieval_failed');
  });

  it('always includes pinned events even when their score is low', async () => {
    const strategy = makeSemanticRetrievalSessionStrategy(1);
    const events = [
      ev(0, 'mission: stay on topic', true), // pinned, a-count 4
      ev(1, 'one'), // a-count 0
      ev(2, 'aaaaaaa'), // a-count 7 — highest score
    ];
    const env = { AI: aiStub() } as unknown as Env;
    const rendered = await runWithContext(makeCtx(env), () =>
      strategy.render(fakeSession(events), [{ role: 'user', content: 'aaa' }], {
        systemPrompt: 'sp',
      }),
    );
    const contents = rendered.slice(1, -1).map((m) => m.content);
    // Pinned is always there; topK=1 picks 'aaaaaaa' from the unpinned pool.
    expect(contents).toContain('mission: stay on topic');
    expect(contents).toContain('aaaaaaa');
  });
});
