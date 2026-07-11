/**
 * Strategy benchmark — measures the working-set size each strategy
 * produces for a fixed 50-turn synthetic session. The point is not to
 * pin exact numbers (model tokenizers don't run in unit tests) but to
 * pin the *relationships* so we don't accidentally regress the leverage
 * the new strategies are supposed to provide:
 *
 *   full_replay        — should keep every event (system + 50 + new)
 *   windowed:N         — should drop everything older than the window
 *   summarizing:N      — should keep the window + a single summary message
 *
 * Measured numbers on this fixture (50 events × ~110 bytes each), as
 * emitted by the tests below:
 *
 *   strategy           messages     content bytes     vs full
 *   ─────────────────  ──────────   ─────────────     ───────
 *   full_replay        52           5671              100%
 *   windowed:5         7            576               10.2%
 *   summarizing:5      8            683               12.0%
 *
 * The assertions enforce the *ratios*, not the exact numbers — updating
 * the synthetic-message length will move the bytes but not the test
 * outcome. Bytes are a proxy for tokens; the real token delta on a
 * Sonnet/Opus call tracks the byte ratio closely for prose text.
 */

import { describe, expect, it } from 'vitest';
import type { ModelChatResult } from '../../../src/patterns/model';
import type { ChatMessage } from '../../../src/patterns/types';
import {
  fullReplaySessionStrategy,
  makeSummarizingSessionStrategy,
  makeWindowedSessionStrategy,
} from '../../../src/session/strategies';
import {
  type AppendableEvent,
  analyzeWake,
  type Session,
  type SessionEvent,
  type SessionEventKind,
} from '../../../src/session/types';

function evMsg(seq: number, role: SessionEvent['role'], content: string): SessionEvent {
  return { seq, ts: seq, kind: role === 'tool' ? 'tool_result' : 'message', role, content };
}

function fixedSession(events: SessionEvent[]): Session {
  const inner = [...events];
  let nextSeq = inner.length;
  return {
    id: 'bench',
    async getEvents(opts?: { kinds?: SessionEventKind[] }) {
      if (!opts?.kinds) return inner.slice();
      const k = new Set(opts.kinds);
      return inner.filter((e) => k.has(e.kind));
    },
    async head() {
      return { seq: nextSeq };
    },
    async append(ev: AppendableEvent) {
      inner.push({ ...ev, seq: nextSeq, ts: ev.ts ?? nextSeq } as SessionEvent);
      nextSeq += 1;
    },
    async appendBatch(evs) {
      for (const ev of evs) {
        inner.push({ ...ev, seq: nextSeq, ts: ev.ts ?? nextSeq } as SessionEvent);
        nextSeq += 1;
      }
    },
    async reset() {
      inner.length = 0;
      nextSeq = 0;
    },
    async wake() {
      return analyzeWake(inner.slice());
    },
  };
}

function summarizerModel(reply: string) {
  return {
    modelId: 'stub',
    route: { provider: 'fake', model: 'stub' },
    async chat(): Promise<ModelChatResult> {
      return { message: { role: 'assistant', content: reply }, stopReason: 'end_turn' };
    },
    async *streamChat() {
      yield '';
      return { message: { role: 'assistant', content: '' }, stopReason: 'end_turn' as const };
    },
  };
}

function build50Turns(): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (let i = 0; i < 50; i += 1) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    // ~80 chars per turn keeps the totals readable while being plausible.
    out.push(
      evMsg(
        i,
        role,
        `turn ${i}: this is filler content to simulate a realistic ${role} message body for benchmarking strategy output size`,
      ),
    );
  }
  return out;
}

function totalContentBytes(messages: ChatMessage[]): number {
  return messages.reduce((acc, m) => acc + m.content.length, 0);
}

describe('SessionStrategy benchmark (50-turn synthetic session)', () => {
  it('windowed:5 cuts working-set size by 80%+ vs full_replay', async () => {
    const events = build50Turns();
    const incoming: ChatMessage[] = [{ role: 'user', content: 'next' }];

    const full = await fullReplaySessionStrategy.render(fixedSession(events), incoming, {
      systemPrompt: 'sp',
    });
    const windowed = await makeWindowedSessionStrategy(5).render(fixedSession(events), incoming, {
      systemPrompt: 'sp',
    });

    const fullBytes = totalContentBytes(full);
    const windowedBytes = totalContentBytes(windowed);

    // Emit raw numbers — paste into docs when these change.
    console.log(
      JSON.stringify({
        bench: 'strategy_50turn',
        strategy: 'full_replay',
        messages: full.length,
        content_bytes: fullBytes,
      }),
    );
    console.log(
      JSON.stringify({
        bench: 'strategy_50turn',
        strategy: 'windowed:5',
        messages: windowed.length,
        content_bytes: windowedBytes,
      }),
    );

    // 50 + system + incoming
    expect(full.length).toBe(52);
    // 5 + system + incoming
    expect(windowed.length).toBe(7);
    // Hard ratio assertion — windowed must be < 25% of full.
    expect(windowedBytes).toBeLessThan(fullBytes * 0.25);
  });

  it('summarizing:5 keeps the window plus one synthetic summary (one model call)', async () => {
    const events = build50Turns();
    const incoming: ChatMessage[] = [{ role: 'user', content: 'next' }];
    const summary = 'User and assistant discussed N topics. Key decisions: A, B. Pending: C.';
    const session = fixedSession(events);
    const strategy = makeSummarizingSessionStrategy(5);

    const rendered = await strategy.render(session, incoming, {
      systemPrompt: 'sp',
      model: summarizerModel(summary) as never,
    });

    const bytes = totalContentBytes(rendered);
    console.log(
      JSON.stringify({
        bench: 'strategy_50turn',
        strategy: 'summarizing:5',
        messages: rendered.length,
        content_bytes: bytes,
      }),
    );

    // system + summary + 5 + incoming = 8
    expect(rendered.length).toBe(8);
    expect(rendered[1]!.content).toContain('Summary of the conversation so far:');
    expect(rendered[1]!.content).toContain(summary);

    // The summary message must be smaller than the events it replaces —
    // that's the entire point. With 45 turns @ ~80 bytes each summarized
    // into one ~80-byte sentence, the delta is the leverage.
    const replacedBytes = events.slice(0, 45).reduce((acc, e) => acc + (e.content?.length ?? 0), 0);
    expect(bytes).toBeLessThan(replacedBytes * 0.25);
  });

  it('full_replay does not call the model; summarizing only calls it once per crossing', async () => {
    const events = build50Turns();
    const incoming: ChatMessage[] = [{ role: 'user', content: 'next' }];
    let modelCalls = 0;
    const countingModel = {
      modelId: 'stub',
      route: { provider: 'fake', model: 'stub' },
      async chat(): Promise<ModelChatResult> {
        modelCalls += 1;
        return { message: { role: 'assistant', content: 'SUMMARY' }, stopReason: 'end_turn' };
      },
      async *streamChat() {
        yield '';
        return { message: { role: 'assistant', content: '' }, stopReason: 'end_turn' as const };
      },
    };
    const session = fixedSession(events);
    const summarizing = makeSummarizingSessionStrategy(5);

    await summarizing.render(session, incoming, {
      systemPrompt: 'sp',
      model: countingModel as never,
    });
    expect(modelCalls).toBe(1);

    // A second render with no new events past the keep window must not
    // call the summarizer again — the cached audit event covers it.
    await summarizing.render(session, [{ role: 'user', content: 'again' }], {
      systemPrompt: 'sp',
      model: countingModel as never,
    });
    expect(modelCalls).toBe(1);
  });
});
