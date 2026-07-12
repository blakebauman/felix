/**
 * Reflect patternverifier-loop wrapper.
 *
 * Pins:
 *   1. max_iterations=1 short-circuits to the inner agent (no
 *      verifier overhead).
 *   2. Verifier above threshold → return inner result unchanged after
 *      one pass.
 *   3. Verifier below threshold → append critique and replay; on the
 *      next pass's pass, that result is returned.
 *   4. Verifier fails (throws) → treat as pass; original response is
 *      kept (no infinite loop on a broken binding).
 *   5. Stuck-below-threshold case: max_iterations reached → return
 *      the last result anyway.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import * as modelModule from '../../src/patterns/model';
import * as reactModule from '../../src/patterns/react';
import { buildReflectAgent } from '../../src/patterns/reflect';
import type { Agent, ChatMessage, InvokeInput, InvokeResult } from '../../src/patterns/types';

function fakeReactAgent(replies: string[]): Agent {
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
 * Streaming-capable fake: each reply streams as one token delta followed by
 * the terminal `on_chain_end` carrying that pass's InvokeResult — mirroring
 * the real react streamEvents contract.
 */
function fakeStreamingReactAgent(replies: string[]): Agent {
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
    async *streamEvents(input: InvokeInput) {
      const reply = replies.shift() ?? 'no more replies';
      yield { event: 'on_chat_model_stream' as const, data: { chunk: { content: reply } } };
      const final: ChatMessage = { role: 'assistant', content: reply };
      yield {
        event: 'on_chain_end' as const,
        data: { output: { messages: [...input.messages, final], final } },
      };
    },
  };
}

function fakeVerifier(scores: number[]) {
  let i = 0;
  return {
    modelId: 'verifier',
    route: { provider: 'fake', model: 'verifier' } as const,
    async chat() {
      const score = scores[i] ?? scores[scores.length - 1]!;
      i += 1;
      return {
        message: {
          role: 'assistant' as const,
          content: `{"score": ${score}, "critique": "iteration ${i - 1} feedback"}`,
        },
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

function ctx(): RequestContext {
  return {
    env: {} as Env,
    auth: ANONYMOUS,
    limitState: newLimitState(),
  };
}

const MODEL_SPEC = {
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildReflectAgent', () => {
  it('short-circuits to the inner agent when max_iterations <= 1', () => {
    const inner = fakeReactAgent(['answer-1']);
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(inner);
    const buildModelSpy = vi
      .spyOn(modelModule, 'buildModel')
      .mockReturnValue(fakeVerifier([0]) as never);
    const wrapped = buildReflectAgent({
      env: {} as Env,
      modelSpec: MODEL_SPEC,
      tools: [],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      primaryModel: MODEL_SPEC,
      reflect: { verifier_model: '', threshold: 0.7, max_iterations: 1, criteria: '' },
    });
    expect(wrapped).toBe(inner);
    expect(buildModelSpy).not.toHaveBeenCalled();
  });

  it('returns the inner result when the verifier passes on the first try', async () => {
    const inner = fakeReactAgent(['great answer']);
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(inner);
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(fakeVerifier([0.9]) as never);
    const wrapped = buildReflectAgent({
      env: {} as Env,
      modelSpec: MODEL_SPEC,
      tools: [],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      primaryModel: MODEL_SPEC,
      reflect: { verifier_model: '', threshold: 0.7, max_iterations: 2, criteria: '' },
    });
    const result = await runWithContext(ctx(), () =>
      wrapped.invoke({ messages: [{ role: 'user', content: 'q' }] }),
    );
    expect(result.final.content).toBe('great answer');
  });

  it('replays with critique when the verifier fails, returning the second pass', async () => {
    const inner = fakeReactAgent(['weak answer', 'much better answer']);
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(inner);
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(fakeVerifier([0.3, 0.95]) as never);
    const wrapped = buildReflectAgent({
      env: {} as Env,
      modelSpec: MODEL_SPEC,
      tools: [],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      primaryModel: MODEL_SPEC,
      reflect: { verifier_model: '', threshold: 0.7, max_iterations: 3, criteria: '' },
    });
    const result = await runWithContext(ctx(), () =>
      wrapped.invoke({ messages: [{ role: 'user', content: 'q' }] }),
    );
    expect(result.final.content).toBe('much better answer');
  });

  it('returns the last result when every pass scores below threshold', async () => {
    const inner = fakeReactAgent(['try 1', 'try 2', 'try 3']);
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(inner);
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(fakeVerifier([0.1, 0.2, 0.3]) as never);
    const wrapped = buildReflectAgent({
      env: {} as Env,
      modelSpec: MODEL_SPEC,
      tools: [],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      primaryModel: MODEL_SPEC,
      reflect: { verifier_model: '', threshold: 0.7, max_iterations: 3, criteria: '' },
    });
    const result = await runWithContext(ctx(), () =>
      wrapped.invoke({ messages: [{ role: 'user', content: 'q' }] }),
    );
    expect(result.final.content).toBe('try 3');
  });

  it('streams a single draft and one terminal event when the verifier passes', async () => {
    const inner = fakeStreamingReactAgent(['great answer']);
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(inner);
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(fakeVerifier([0.9]) as never);
    const wrapped = buildReflectAgent({
      env: {} as Env,
      modelSpec: MODEL_SPEC,
      tools: [],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      primaryModel: MODEL_SPEC,
      reflect: { verifier_model: '', threshold: 0.7, max_iterations: 2, criteria: '' },
    });
    const events = await runWithContext(ctx(), async () => {
      const out: Array<{ event: string; content?: string }> = [];
      for await (const ev of wrapped.streamEvents({ messages: [{ role: 'user', content: 'q' }] })) {
        if (ev.event === 'on_chat_model_stream') {
          out.push({ event: ev.event, content: ev.data.chunk.content });
        } else if (ev.event === 'on_chain_end') {
          out.push({ event: ev.event, content: ev.data.output.final.content });
        }
      }
      return out;
    });
    const deltas = events.filter((e) => e.event === 'on_chat_model_stream');
    const terminals = events.filter((e) => e.event === 'on_chain_end');
    expect(deltas.map((d) => d.content)).toEqual(['great answer']);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.content).toBe('great answer');
  });

  it('streams both drafts live but emits exactly one terminal (the revision) on re-run', async () => {
    const inner = fakeStreamingReactAgent(['weak answer', 'much better answer']);
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(inner);
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(fakeVerifier([0.3, 0.95]) as never);
    const wrapped = buildReflectAgent({
      env: {} as Env,
      modelSpec: MODEL_SPEC,
      tools: [],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      primaryModel: MODEL_SPEC,
      reflect: { verifier_model: '', threshold: 0.7, max_iterations: 3, criteria: '' },
    });
    const events = await runWithContext(ctx(), async () => {
      const out: Array<{ event: string; content?: string }> = [];
      for await (const ev of wrapped.streamEvents({ messages: [{ role: 'user', content: 'q' }] })) {
        if (ev.event === 'on_chat_model_stream') {
          out.push({ event: ev.event, content: ev.data.chunk.content });
        } else if (ev.event === 'on_chain_end') {
          out.push({ event: ev.event, content: ev.data.output.final.content });
        }
      }
      return out;
    });
    const deltas = events.filter((e) => e.event === 'on_chat_model_stream');
    const terminals = events.filter((e) => e.event === 'on_chain_end');
    // Both drafts stream live; only the accepted revision terminates the stream.
    expect(deltas.map((d) => d.content)).toEqual(['weak answer', 'much better answer']);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.content).toBe('much better answer');
  });

  it('records verifier token usage against the request budget', async () => {
    const inner = fakeReactAgent(['great answer']);
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(inner);
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(fakeVerifier([0.9]) as never);
    const recordUsageSpy = vi.spyOn(modelModule, 'recordUsage');
    const wrapped = buildReflectAgent({
      env: {} as Env,
      modelSpec: MODEL_SPEC,
      tools: [],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      primaryModel: MODEL_SPEC,
      reflect: { verifier_model: 'verifier', threshold: 0.7, max_iterations: 2, criteria: '' },
    });
    await runWithContext(ctx(), () =>
      wrapped.invoke({ messages: [{ role: 'user', content: 'q' }] }),
    );
    // The verifier call must flow through recordUsage so its tokens count
    // against max_input/output_tokens and the orchestrator_tokens metric.
    expect(recordUsageSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ manifestId: 'm', modelId: 'verifier' }),
    );
  });

  it('treats a thrown verifier as a pass (no infinite loop on a broken binding)', async () => {
    const inner = fakeReactAgent(['only answer']);
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(inner);
    const broken = {
      modelId: 'verifier',
      route: { provider: 'fake', model: 'verifier' } as const,
      async chat() {
        throw new Error('verifier binding offline');
      },
      async *streamChat() {
        yield '';
        return {
          message: { role: 'assistant' as const, content: '' },
          stopReason: 'end_turn' as const,
        };
      },
    };
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(broken as never);
    const wrapped = buildReflectAgent({
      env: {} as Env,
      modelSpec: MODEL_SPEC,
      tools: [],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      primaryModel: MODEL_SPEC,
      reflect: { verifier_model: '', threshold: 0.7, max_iterations: 3, criteria: '' },
    });
    const result = await runWithContext(ctx(), () =>
      wrapped.invoke({ messages: [{ role: 'user', content: 'q' }] }),
    );
    expect(result.final.content).toBe('only answer');
  });
});
