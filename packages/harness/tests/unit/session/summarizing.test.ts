/**
 * SummarizingStrategy compresses old turns into a synthetic system
 * summary, caches it as a `kind: 'audit'` event, and skips re-summarizing
 * on subsequent renders until new events cross the keep boundary.
 *
 * Pins:
 *   1. Below threshold → no model call, no summary, raw events replayed.
 *   2. Above threshold → one model call, summary in rendered output,
 *      cached as an audit event with `metadata.covers_to_seq`.
 *   3. Re-render with the cache present → no second model call.
 *   4. Re-render after new events push count past threshold again →
 *      another model call that includes the prior summary in context.
 *   5. Missing `model` opt → degrades to windowed; no throw.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as metrics from '../../../src/observability/metrics';
import type { ModelChatResult } from '../../../src/patterns/model';
import type { ChatMessage } from '../../../src/patterns/types';
import { makeSummarizingSessionStrategy } from '../../../src/session/strategies';
import {
  type AppendableEvent,
  analyzeWake,
  type Session,
  type SessionEvent,
  type SessionEventKind,
} from '../../../src/session/types';

function evMsg(seq: number, role: SessionEvent['role'], content: string): SessionEvent {
  return {
    seq,
    ts: seq,
    kind: role === 'tool' ? 'tool_result' : 'message',
    role,
    content,
  };
}

function mutableSession(initial: SessionEvent[] = []): Session & { appended: AppendableEvent[] } {
  const events = [...initial];
  let nextSeq = initial.length;
  const appended: AppendableEvent[] = [];
  return {
    id: 't',
    appended,
    async getEvents(opts?: { kinds?: SessionEventKind[] }) {
      if (!opts?.kinds) return events.slice();
      const kindSet = new Set(opts.kinds);
      return events.filter((e) => kindSet.has(e.kind));
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
}

function fakeModel(replies: string[]) {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    modelId: 'stub',
    route: { provider: 'fake', model: 'stub' },
    async chat(messages: ChatMessage[]): Promise<ModelChatResult> {
      calls.push(messages);
      const next = replies.shift();
      if (next === undefined) throw new Error('out of stubbed summarizer replies');
      return { message: { role: 'assistant', content: next }, stopReason: 'end_turn' };
    },
    async *streamChat() {
      yield '';
      return { message: { role: 'assistant', content: '' }, stopReason: 'end_turn' as const };
    },
  };
}

describe('SummarizingStrategy', () => {
  it('renders raw events when count <= keep (no model call)', async () => {
    const session = mutableSession([evMsg(0, 'user', 'a'), evMsg(1, 'assistant', 'b')]);
    const model = fakeModel([]);
    const strategy = makeSummarizingSessionStrategy(3);
    const rendered = await strategy.render(session, [{ role: 'user', content: 'c' }], {
      systemPrompt: 'sp',
      model: model as never,
    });
    expect(rendered.map((m) => m.content)).toEqual(['sp', 'a', 'b', 'c']);
    expect(model.calls).toHaveLength(0);
    expect(session.appended).toHaveLength(0);
  });

  it('summarizes old events when count > keep, caches as audit, and inserts a system summary', async () => {
    const session = mutableSession([
      evMsg(0, 'user', 'old-1'),
      evMsg(1, 'assistant', 'old-2'),
      evMsg(2, 'user', 'old-3'),
      evMsg(3, 'assistant', 'keep-1'),
      evMsg(4, 'user', 'keep-2'),
    ]);
    const model = fakeModel(['SUMMARY']);
    const strategy = makeSummarizingSessionStrategy(2);
    const rendered = await strategy.render(session, [{ role: 'user', content: 'now' }], {
      systemPrompt: 'sp',
      model: model as never,
    });
    expect(rendered.map((m) => m.content)).toEqual([
      'sp',
      'Summary of the conversation so far:\nSUMMARY',
      'keep-1',
      'keep-2',
      'now',
    ]);
    expect(model.calls).toHaveLength(1);
    expect(session.appended).toHaveLength(1);
    const audit = session.appended[0]!;
    expect(audit.kind).toBe('audit');
    expect(audit.content).toBe('SUMMARY');
    expect((audit.metadata as { type?: string; covers_to_seq?: number }).type).toBe(
      'session_summary',
    );
    expect((audit.metadata as { covers_to_seq?: number }).covers_to_seq).toBe(2);
  });

  it('uses the cached summary on the next render without a second model call', async () => {
    const session = mutableSession([
      evMsg(0, 'user', 'old-1'),
      evMsg(1, 'assistant', 'old-2'),
      evMsg(2, 'user', 'old-3'),
      evMsg(3, 'assistant', 'keep-1'),
      evMsg(4, 'user', 'keep-2'),
    ]);
    const model = fakeModel(['SUMMARY']);
    const strategy = makeSummarizingSessionStrategy(2);
    await strategy.render(session, [{ role: 'user', content: 'now' }], {
      systemPrompt: 'sp',
      model: model as never,
    });
    expect(model.calls).toHaveLength(1);
    // Second render: nothing new past the cached summary boundary except
    // keep-1 and keep-2 (already within the keep window). No model call.
    const rendered2 = await strategy.render(session, [{ role: 'user', content: 'next' }], {
      systemPrompt: 'sp',
      model: model as never,
    });
    expect(model.calls).toHaveLength(1);
    expect(rendered2.map((m) => m.content)).toEqual([
      'sp',
      'Summary of the conversation so far:\nSUMMARY',
      'keep-1',
      'keep-2',
      'next',
    ]);
  });

  it('re-summarizes when new events push the raw window past keep, feeding the prior summary back in', async () => {
    const session = mutableSession([
      evMsg(0, 'user', 'old-1'),
      evMsg(1, 'assistant', 'old-2'),
      evMsg(2, 'user', 'old-3'),
      evMsg(3, 'assistant', 'keep-1'),
      evMsg(4, 'user', 'keep-2'),
    ]);
    const model = fakeModel(['SUMMARY-1', 'SUMMARY-2']);
    const strategy = makeSummarizingSessionStrategy(2);
    await strategy.render(session, [{ role: 'user', content: 'now' }], {
      systemPrompt: 'sp',
      model: model as never,
    });
    // Append two new raw events that push prior keep-* past the window.
    await session.append({ kind: 'message', role: 'assistant', content: 'new-1' });
    await session.append({ kind: 'message', role: 'user', content: 'new-2' });
    const rendered2 = await strategy.render(session, [{ role: 'user', content: 'next' }], {
      systemPrompt: 'sp',
      model: model as never,
    });
    expect(model.calls).toHaveLength(2);
    // The second summarizer call must include the prior summary in its
    // prompt context so context isn't lost across re-summarization.
    const secondCall = model.calls[1]!;
    const hasPriorSummary = secondCall.some(
      (m) =>
        m.content.includes('Summary of the conversation so far:') &&
        m.content.includes('SUMMARY-1'),
    );
    expect(hasPriorSummary).toBe(true);
    expect(rendered2.map((m) => m.content)).toEqual([
      'sp',
      'Summary of the conversation so far:\nSUMMARY-2',
      'new-1',
      'new-2',
      'next',
    ]);
  });

  it('degrades to windowed when no model is supplied', async () => {
    const session = mutableSession([
      evMsg(0, 'user', 'old'),
      evMsg(1, 'assistant', 'keep-1'),
      evMsg(2, 'user', 'keep-2'),
    ]);
    const strategy = makeSummarizingSessionStrategy(2);
    const rendered = await strategy.render(session, [{ role: 'user', content: 'now' }], {
      systemPrompt: 'sp',
    });
    // Without a model, the strategy falls back to keeping the last `keep`
    // events and dropping the rest — no summary message inserted.
    expect(rendered.map((m) => m.content)).toEqual(['sp', 'keep-1', 'keep-2', 'now']);
    expect(session.appended).toHaveLength(0);
  });

  it('degrades to windowed AND emits a counter when the summarizer call throws', async () => {
    const counterSpy = vi.spyOn(metrics, 'recordCounter').mockImplementation(() => {});
    const session = mutableSession([
      evMsg(0, 'user', 'old'),
      evMsg(1, 'assistant', 'keep-1'),
      evMsg(2, 'user', 'keep-2'),
    ]);
    const failing = {
      modelId: 'stub',
      route: { provider: 'fake', model: 'stub' },
      async chat(): Promise<ModelChatResult> {
        throw new Error('summarizer down');
      },
      async *streamChat() {
        yield '';
        return { message: { role: 'assistant', content: '' }, stopReason: 'end_turn' as const };
      },
    };
    const strategy = makeSummarizingSessionStrategy(2);
    const rendered = await strategy.render(session, [{ role: 'user', content: 'now' }], {
      systemPrompt: 'sp',
      model: failing as never,
    });
    expect(rendered.map((m) => m.content)).toEqual(['sp', 'keep-1', 'keep-2', 'now']);
    expect(session.appended).toHaveLength(0);
    // The silent degrade (summarizing -> windowed) is now observable.
    expect(counterSpy).toHaveBeenCalledWith('orchestrator_session_summarize_failures');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
