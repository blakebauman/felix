/**
 * Token budget enforcement across all three patterns that make their own
 * model.chat calls (react / router / parallel). The shared `LimitState`
 * accumulates token spend; `checkTokenBudget(limits, manifestId)` runs
 * before each model call and short-circuits when the budget is blown.
 *
 * Setup pre-loads `state.tokens.input` past the cap so the first model
 * call sees a deny — no real model invocation needed.
 */

import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import * as modelModule from '../../src/patterns/model';
import { buildParallelAgent } from '../../src/patterns/parallel';
import { buildReactAgent } from '../../src/patterns/react';
import { buildRouterAgent } from '../../src/patterns/router';
import type { Agent, ChatMessage } from '../../src/patterns/types';

function ctxWithTokensSpent(input: number, output = 0): RequestContext {
  const limitState = newLimitState();
  limitState.tokens.input = input;
  limitState.tokens.output = output;
  return { env: {} as Env, auth: ANONYMOUS, limitState };
}

const tightInputBudget = {
  max_tool_calls: null,
  max_wall_clock_seconds: null,
  max_peer_hops: null,
  max_input_tokens: 10,
  max_output_tokens: null,
  precount: false,
};

function fakeModel() {
  return {
    modelId: 'stub',
    route: { provider: 'anthropic', model: 'stub' } as const,
    chat: vi.fn(async () => ({
      message: { role: 'assistant', content: 'should-not-run' } as ChatMessage,
      stopReason: 'end_turn' as const,
    })),
    streamChat: vi.fn(),
  };
}

function fixedAgent(content: string): Agent {
  return {
    tools: [],
    pattern: 'react',
    manifestId: 'sub',
    manifestVersion: '1.0.0',
    async invoke(input) {
      const final: ChatMessage = { role: 'assistant', content };
      return { messages: [...input.messages, final], final };
    },
    async *streamEvents() {},
  };
}

describe('token budget short-circuits before model call', () => {
  it('react agent returns a deny without invoking the model', async () => {
    const stubbed = fakeModel();
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(stubbed as never);
    const agent = buildReactAgent({
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
      tools: [],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      limits: tightInputBudget,
    });
    const result = await runWithContext(ctxWithTokensSpent(100), async () =>
      agent.invoke({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(stubbed.chat).not.toHaveBeenCalled();
    expect(result.final.role).toBe('assistant');
    expect(result.final.content).toContain('[limit exceeded] max_input_tokens');
  });

  it('router falls back to the first sub-agent without classifying', async () => {
    const stubbed = fakeModel();
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(stubbed as never);
    const agent = buildRouterAgent({
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
      subAgents: { primary: fixedAgent('primary-output'), other: fixedAgent('other-output') },
      classifierPrompt: 'classify',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      limits: tightInputBudget,
    });
    const result = await runWithContext(ctxWithTokensSpent(100), async () =>
      agent.invoke({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(stubbed.chat).not.toHaveBeenCalled();
    expect(result.final.content).toBe('primary-output');
  });

  it('parallel returns a deny from the aggregator without synthesizing', async () => {
    const stubbed = fakeModel();
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(stubbed as never);
    const agent = buildParallelAgent({
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
      subAgents: { a: fixedAgent('a-out'), b: fixedAgent('b-out') },
      aggregatorPrompt: 'aggregate',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      limits: tightInputBudget,
    });
    const result = await runWithContext(ctxWithTokensSpent(100), async () =>
      agent.invoke({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(stubbed.chat).not.toHaveBeenCalled();
    expect(result.final.content).toContain('[limit exceeded] max_input_tokens');
  });
});

describe('recordUsage accumulates onto LimitState across patterns', () => {
  it('aggregates input and output tokens across multiple model results', async () => {
    const c = ctxWithTokensSpent(0);
    await runWithContext(c, async () => {
      modelModule.recordUsage(
        {
          message: { role: 'assistant', content: '' },
          stopReason: 'end_turn',
          usage: { input: 5, output: 3 },
        },
        { manifestId: 'm', modelId: 'claude' },
      );
      modelModule.recordUsage(
        {
          message: { role: 'assistant', content: '' },
          stopReason: 'end_turn',
          usage: { input: 7, output: 2 },
        },
        { manifestId: 'm', modelId: 'claude' },
      );
    });
    expect(c.limitState.tokens.input).toBe(12);
    expect(c.limitState.tokens.output).toBe(5);
  });
});
