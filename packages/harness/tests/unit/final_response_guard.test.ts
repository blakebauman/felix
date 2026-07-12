/**
 * Output guardrails on the model's final answer (`guardrails/final-response.ts`).
 * Pins:
 *   - disabled unless `final_response` ∈ targets (and there's a provider)
 *   - redact mode masks PII in the answer; block mode replaces the whole answer
 *   - clean content returns the SAME message (no copy, no audit noise)
 *   - only `content` is touched — `thinking` blocks are preserved
 *   - a `guardrail_block { surface: 'final_response' }` audit fires on a match
 */

import { describe, expect, it, vi } from 'vitest';
import * as auditStore from '../../src/audit/store';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { guardFinalResponse, guardFinalResponseText } from '../../src/guardrails/final-response';
import { DEFAULT_GUARDRAILS, type Guardrails } from '../../src/guardrails/models';
import type { ChatMessage } from '../../src/patterns/types';

function ctx(): RequestContext {
  return { env: {} as unknown as Env, auth: ANONYMOUS, limitState: newLimitState() };
}

/** Context with a Workers-AI stub for the judge path. */
function ctxWithAi(reply: string): RequestContext {
  const env = { AI: { run: async () => ({ response: reply }) } } as unknown as Env;
  return { env, auth: ANONYMOUS, limitState: newLimitState() };
}

function guardrails(over: Partial<Guardrails>): Guardrails {
  return { ...DEFAULT_GUARDRAILS, ...over };
}

function finalJudge(threshold = 0.7): Guardrails['judges'][number] {
  return {
    name: 'answer_quality',
    criteria: 'the answer is on-topic and safe',
    threshold,
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    target_tools: [],
    final_response: true,
  };
}

const PII_ANSWER = 'Sure — email me at jane@example.com and my SSN is 123-45-6789.';

describe('guardFinalResponse', () => {
  it('is a no-op when final_response is not a target', async () => {
    const msg: ChatMessage = { role: 'assistant', content: PII_ANSWER };
    const g = guardrails({ providers: ['pii'], targets: ['input', 'output'] });
    const out = await runWithContext(ctx(), () => guardFinalResponse(msg, g, 'm'));
    expect(out).toBe(msg); // same reference
  });

  it('is a no-op when there is no provider even if final_response is a target', async () => {
    const msg: ChatMessage = { role: 'assistant', content: PII_ANSWER };
    const g = guardrails({ providers: [], targets: ['final_response'] });
    const out = await runWithContext(ctx(), () => guardFinalResponse(msg, g, 'm'));
    expect(out).toBe(msg);
  });

  it('redacts PII in the final answer (redact mode)', async () => {
    const msg: ChatMessage = { role: 'assistant', content: PII_ANSWER };
    const g = guardrails({
      providers: ['pii'],
      targets: ['output', 'final_response'],
      final_response: { on_match: 'redact', streaming: 'buffer' },
    });
    const out = await runWithContext(ctx(), () => guardFinalResponse(msg, g, 'm'));
    expect(out).not.toBe(msg);
    expect(out.content).toContain('[REDACTED:email]');
    expect(out.content).toContain('[REDACTED:ssn]');
    expect(out.content).not.toContain('jane@example.com');
  });

  it('replaces the whole answer in block mode', async () => {
    const msg: ChatMessage = { role: 'assistant', content: PII_ANSWER };
    const g = guardrails({
      providers: ['pii'],
      targets: ['final_response'],
      final_response: { on_match: 'block', streaming: 'buffer' },
    });
    const out = await runWithContext(ctx(), () => guardFinalResponse(msg, g, 'm'));
    expect(out.content).toBe('[response withheld by output policy]');
  });

  it('returns the same message and emits no audit when the answer is clean', async () => {
    const spy = vi.spyOn(auditStore, 'recordEvent');
    const msg: ChatMessage = { role: 'assistant', content: 'The weather is sunny.' };
    const g = guardrails({ providers: ['pii'], targets: ['final_response'] });
    const out = await runWithContext(ctx(), () => guardFinalResponse(msg, g, 'm'));
    expect(out).toBe(msg);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('preserves thinking blocks (only content is filtered)', async () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: PII_ANSWER,
      thinking: [{ type: 'thinking', thinking: 'reasoning…', signature: 'sig' }],
    };
    const g = guardrails({ providers: ['pii'], targets: ['final_response'] });
    const out = await runWithContext(ctx(), () => guardFinalResponse(msg, g, 'm'));
    expect(out.thinking).toEqual(msg.thinking);
    expect(out.content).not.toContain('jane@example.com');
  });

  it('emits a guardrail_block audit with surface=final_response on a match', async () => {
    const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
    vi.spyOn(auditStore, 'recordEvent').mockImplementation((opts) => {
      events.push({ eventType: opts.eventType, payload: opts.payload });
      return { id: 'x' } as never;
    });
    const msg: ChatMessage = { role: 'assistant', content: PII_ANSWER };
    const g = guardrails({ providers: ['pii'], targets: ['final_response'] });
    await runWithContext(ctx(), () => guardFinalResponse(msg, g, 'm'));
    const block = events.find((e) => e.eventType === 'guardrail_block');
    expect(block?.payload?.surface).toBe('final_response');
    vi.restoreAllMocks();
  });
});

describe('guardFinalResponseText (streaming buffer path)', () => {
  it('redacts a raw buffered string', async () => {
    const g = guardrails({ providers: ['pii'], targets: ['final_response'] });
    const out = await runWithContext(ctx(), () => guardFinalResponseText(PII_ANSWER, g, 'm'));
    expect(out).toContain('[REDACTED:ssn]');
  });

  it('returns the input unchanged when disabled', async () => {
    const g = guardrails({ providers: ['pii'], targets: ['output'] });
    const out = await runWithContext(ctx(), () => guardFinalResponseText(PII_ANSWER, g, 'm'));
    expect(out).toBe(PII_ANSWER);
  });
});

describe('final-response judges', () => {
  it('runs a judges-only guard (no content-filter provider needed)', async () => {
    const msg: ChatMessage = { role: 'assistant', content: 'the answer' };
    const g = guardrails({ providers: [], targets: ['final_response'], judges: [finalJudge()] });
    const out = await runWithContext(ctxWithAi('{"score": 0.9, "reasoning": "good"}'), () =>
      guardFinalResponse(msg, g, 'm'),
    );
    // Passing judge → answer unchanged.
    expect(out.content).toBe('the answer');
  });

  it('blocks the answer when a final-response judge scores below threshold', async () => {
    const msg: ChatMessage = { role: 'assistant', content: 'off-mission ramble' };
    const g = guardrails({ providers: [], targets: ['final_response'], judges: [finalJudge()] });
    const out = await runWithContext(ctxWithAi('{"score": 0.2, "reasoning": "off-topic"}'), () =>
      guardFinalResponse(msg, g, 'm'),
    );
    expect(out.content).toBe('[response withheld by output policy]');
  });

  it('emits a judge_score audit with source=final_response', async () => {
    const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
    vi.spyOn(auditStore, 'recordEvent').mockImplementation((opts) => {
      events.push({ eventType: opts.eventType, payload: opts.payload });
      return { id: 'x' } as never;
    });
    const msg: ChatMessage = { role: 'assistant', content: 'the answer' };
    const g = guardrails({ providers: [], targets: ['final_response'], judges: [finalJudge()] });
    await runWithContext(ctxWithAi('{"score": 0.9, "reasoning": "good"}'), () =>
      guardFinalResponse(msg, g, 'm'),
    );
    const score = events.find((e) => e.eventType === 'judge_score');
    expect(score?.payload?.source).toBe('final_response');
    vi.restoreAllMocks();
  });

  it('skips the judge (does not block) when the AI binding is absent', async () => {
    const msg: ChatMessage = { role: 'assistant', content: 'the answer' };
    const g = guardrails({ providers: [], targets: ['final_response'], judges: [finalJudge()] });
    // ctx() has no env.AI → judgeOne returns null → skipped, answer stands.
    const out = await runWithContext(ctx(), () => guardFinalResponse(msg, g, 'm'));
    expect(out.content).toBe('the answer');
  });
});

describe('final_response schema cross-field validation', () => {
  it("rejects on_match 'block' combined with streaming 'incremental'", async () => {
    const { GuardrailsSchema } = await import('../../src/guardrails/models');
    const parsed = GuardrailsSchema.safeParse({
      providers: ['pii'],
      targets: ['final_response'],
      final_response: { on_match: 'block', streaming: 'incremental' },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/cannot be combined/);
  });

  it('accepts block+buffer and redact+incremental', async () => {
    const { GuardrailsSchema } = await import('../../src/guardrails/models');
    for (const final_response of [
      { on_match: 'block', streaming: 'buffer' },
      { on_match: 'block', streaming: 'passthrough' },
      { on_match: 'redact', streaming: 'incremental' },
    ]) {
      const parsed = GuardrailsSchema.safeParse({
        providers: ['pii'],
        targets: ['final_response'],
        final_response,
      });
      expect(parsed.success).toBe(true);
    }
  });
});
