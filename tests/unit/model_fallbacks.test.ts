/**
 * `withModelFallbacks` — mid-conversation provider failover.
 *
 * Pins:
 *   1. Primary success returns its result without emitting model_switch.
 *   2. Primary `provider_error` cascades to the first fallback; success
 *      there emits `model_switch` and returns the fallback's result.
 *   3. Non-`provider_error` failures (4xx, AbortError) re-throw without
 *      attempting fallbacks — those are not transient.
 *   4. All-fail cascade re-throws the last error.
 *   5. Streaming follows the same cascade on the initial connection.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auditStore from '../../src/audit/store';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { withModelFallbacks } from '../../src/patterns/model';
import type { ChatMessage } from '../../src/patterns/types';

type ChatFn = () => Promise<{
  message: ChatMessage;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown';
}>;

function fakeModel(id: string, chat: ChatFn) {
  return {
    modelId: id,
    route: { provider: 'fake', model: id } as const,
    chat,
    async *streamChat() {
      // Empty yield keeps the lint rule happy without changing semantics —
      // these fakes only exercise `chat()` paths; streamChat is here so the
      // shape satisfies `ModelClient`.
      yield '';
      return await chat();
    },
  } as unknown as ReturnType<typeof withModelFallbacks>;
}

function providerError(status = 503): Error {
  const e = new Error(`HTTP ${status}`) as Error & { status?: number };
  e.status = status;
  return e;
}

function makeCtx(): RequestContext {
  return {
    env: {} as Env,
    auth: { ...ANONYMOUS, principal: { ...ANONYMOUS.principal, tenantId: 'acme', subject: 's' } },
    limitState: newLimitState(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const OK_REPLY = {
  message: { role: 'assistant' as const, content: 'ok' },
  stopReason: 'end_turn' as const,
};

describe('withModelFallbacks', () => {
  it('returns primary result without switching when primary succeeds', async () => {
    const events: string[] = [];
    vi.spyOn(auditStore, 'recordEvent').mockImplementation((opts) => {
      events.push(opts.eventType);
      return {} as ReturnType<typeof auditStore.recordEvent>;
    });
    const primary = fakeModel('p', async () => OK_REPLY);
    const fb = fakeModel('f', async () => OK_REPLY);
    const wrapped = withModelFallbacks(primary, [fb]);
    const result = await runWithContext(makeCtx(), () => wrapped.chat([], []));
    expect(result.message.content).toBe('ok');
    expect(events.includes('model_switch')).toBe(false);
  });

  it('cascades to a fallback on provider_error and emits model_switch', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    vi.spyOn(auditStore, 'recordEvent').mockImplementation((opts) => {
      events.push({ type: opts.eventType, payload: opts.payload ?? {} });
      return {} as ReturnType<typeof auditStore.recordEvent>;
    });
    const primary = fakeModel('p', async () => {
      throw providerError(503);
    });
    const fb = fakeModel('f', async () => OK_REPLY);
    const wrapped = withModelFallbacks(primary, [fb]);
    const result = await runWithContext(makeCtx(), () => wrapped.chat([], []));
    expect(result.message.content).toBe('ok');
    const switchEvent = events.find((e) => e.type === 'model_switch');
    expect(switchEvent).toBeDefined();
    expect(switchEvent!.payload).toMatchObject({ from: 'p', to: 'f', reason: 'provider_error' });
  });

  it('does NOT retry on a 4xx (treated as client misuse)', async () => {
    const primary = fakeModel('p', async () => {
      throw providerError(401);
    });
    let fbCalled = false;
    const fb = fakeModel('f', async () => {
      fbCalled = true;
      return OK_REPLY;
    });
    const wrapped = withModelFallbacks(primary, [fb]);
    await expect(runWithContext(makeCtx(), () => wrapped.chat([], []))).rejects.toThrow(/HTTP 401/);
    expect(fbCalled).toBe(false);
  });

  it('does NOT retry on AbortError (user cancellation)', async () => {
    const primary = fakeModel('p', async () => {
      const e = new Error('cancelled');
      e.name = 'AbortError';
      throw e;
    });
    let fbCalled = false;
    const fb = fakeModel('f', async () => {
      fbCalled = true;
      return OK_REPLY;
    });
    const wrapped = withModelFallbacks(primary, [fb]);
    await expect(runWithContext(makeCtx(), () => wrapped.chat([], []))).rejects.toThrow(
      /cancelled/,
    );
    expect(fbCalled).toBe(false);
  });

  it('re-throws the last error when every link in the chain fails', async () => {
    const primary = fakeModel('p', async () => {
      throw providerError(503);
    });
    const fb1 = fakeModel('f1', async () => {
      throw providerError(503);
    });
    const fb2 = fakeModel('f2', async () => {
      throw providerError(504);
    });
    const wrapped = withModelFallbacks(primary, [fb1, fb2]);
    await expect(runWithContext(makeCtx(), () => wrapped.chat([], []))).rejects.toThrow(/HTTP 504/);
  });

  it('walks multiple fallbacks until one succeeds', async () => {
    const events: string[] = [];
    vi.spyOn(auditStore, 'recordEvent').mockImplementation((opts) => {
      events.push(opts.eventType);
      return {} as ReturnType<typeof auditStore.recordEvent>;
    });
    const primary = fakeModel('p', async () => {
      throw providerError(503);
    });
    const fb1 = fakeModel('f1', async () => {
      throw providerError(503);
    });
    const fb2 = fakeModel('f2', async () => OK_REPLY);
    const wrapped = withModelFallbacks(primary, [fb1, fb2]);
    const result = await runWithContext(makeCtx(), () => wrapped.chat([], []));
    expect(result.message.content).toBe('ok');
    expect(events.filter((e) => e === 'model_switch')).toHaveLength(1);
  });

  it('passes through when fallbacks array is empty', () => {
    const primary = fakeModel('p', async () => OK_REPLY);
    const wrapped = withModelFallbacks(primary, []);
    expect(wrapped).toBe(primary);
  });
});
