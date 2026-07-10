/**
 * Confidence-routed model escalation.
 *
 * Pins:
 *   1. High-confidence response passes through; no escalation, no audit.
 *   2. Response matching a low-confidence marker escalates to the
 *      fallback model; emits model_switch with reason='low_confidence'.
 *   3. Response shorter than `min_response_chars` also escalates.
 *   4. Empty response is treated as low-confidence (the strictest case).
 *   5. streamChat passes through — buffering the whole stream defeats
 *      the streaming UX so v1 doesn't wrap streams.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auditStore from '../../src/audit/store';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { withConfidenceEscalation } from '../../src/patterns/model';

function fakeModel(id: string, response: string) {
  return {
    modelId: id,
    route: { provider: 'fake', model: id } as const,
    async chat() {
      return {
        message: { role: 'assistant' as const, content: response },
        stopReason: 'end_turn' as const,
      };
    },
    async *streamChat() {
      yield '';
      return {
        message: { role: 'assistant' as const, content: response },
        stopReason: 'end_turn' as const,
      };
    },
  } as unknown as ReturnType<typeof withConfidenceEscalation>;
}

function makeCtx(): RequestContext {
  return {
    env: {} as Env,
    auth: { ...ANONYMOUS, principal: { ...ANONYMOUS.principal, tenantId: 'acme', subject: 's' } },
    limitState: newLimitState(),
  };
}

const MARKERS = ['i am not sure', "i don't know", 'unclear'];
const MIN = 40;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withConfidenceEscalation', () => {
  it('passes through high-confidence responses unchanged', async () => {
    const events: string[] = [];
    vi.spyOn(auditStore, 'recordEvent').mockImplementation((opts) => {
      events.push(opts.eventType);
      return {} as ReturnType<typeof auditStore.recordEvent>;
    });
    const primary = fakeModel(
      'p',
      'A confident, sufficiently long answer that says something meaningful.',
    );
    const escalate = fakeModel('escalate', 'should not be reached');
    const wrapped = withConfidenceEscalation(primary, escalate, {
      markers: MARKERS,
      minResponseChars: MIN,
    });
    const result = await runWithContext(makeCtx(), () => wrapped.chat([], []));
    expect(result.message.content).toMatch(/confident/);
    expect(events).not.toContain('model_switch');
  });

  it('escalates when the response matches a low-confidence marker', async () => {
    let switched = false;
    vi.spyOn(auditStore, 'recordEvent').mockImplementation((opts) => {
      if (opts.eventType === 'model_switch') {
        switched = true;
        expect((opts.payload as { reason: string }).reason).toBe('low_confidence');
      }
      return {} as ReturnType<typeof auditStore.recordEvent>;
    });
    const primary = fakeModel('p', 'Hmm, I am not sure how to answer this question, sorry.');
    const escalate = fakeModel('escalate', 'A confident detailed answer from the flagship model.');
    const wrapped = withConfidenceEscalation(primary, escalate, {
      markers: MARKERS,
      minResponseChars: MIN,
    });
    const result = await runWithContext(makeCtx(), () => wrapped.chat([], []));
    expect(result.message.content).toMatch(/flagship/);
    expect(switched).toBe(true);
  });

  it('escalates when the response is shorter than min_response_chars', async () => {
    const primary = fakeModel('p', 'sure'); // 4 chars < 40
    const escalate = fakeModel('escalate', 'A thorough answer with enough substance to pass.');
    const wrapped = withConfidenceEscalation(primary, escalate, {
      markers: MARKERS,
      minResponseChars: MIN,
    });
    const result = await runWithContext(makeCtx(), () => wrapped.chat([], []));
    expect(result.message.content).toMatch(/substance/);
  });

  it('escalates on an empty response (strictest case)', async () => {
    const primary = fakeModel('p', '');
    const escalate = fakeModel('escalate', 'Recovered answer with real content here.');
    const wrapped = withConfidenceEscalation(primary, escalate, {
      markers: MARKERS,
      minResponseChars: MIN,
    });
    const result = await runWithContext(makeCtx(), () => wrapped.chat([], []));
    expect(result.message.content).toMatch(/Recovered/);
  });

  it('passes streamChat straight through without buffering', async () => {
    const primary = fakeModel('p', 'short');
    const escalate = fakeModel('escalate', 'long enough to pass the threshold easily here.');
    const wrapped = withConfidenceEscalation(primary, escalate, {
      markers: MARKERS,
      minResponseChars: MIN,
    });
    const gen = wrapped.streamChat([], []);
    const yields: string[] = [];
    let result: Awaited<ReturnType<typeof gen.next>>['value'];
    while (true) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      yields.push(next.value);
    }
    // Streaming did NOT escalate — primary's response is what comes
    // through even though it's short.
    if (!result || typeof result === 'string') throw new Error('expected ModelChatResult');
    expect(result.message.content).toBe('short');
  });
});
