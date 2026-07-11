/**
 * The final-response guard applied at the parent level of multi-agent
 * patterns: parallel guards the aggregator's synthesized answer; groupchat
 * guards the returned (last speaker's) answer. router is a pass-through and
 * delegates to the chosen sub-agent's own guard — not covered here.
 */

import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { DEFAULT_GUARDRAILS, type Guardrails } from '../../src/guardrails/models';
import { buildGroupchatAgent } from '../../src/patterns/groupchat';
import * as modelModule from '../../src/patterns/model';
import { buildParallelAgent } from '../../src/patterns/parallel';
import type { Agent, ChatMessage } from '../../src/patterns/types';

function ctx(): RequestContext {
  return { env: {} as Env, auth: ANONYMOUS, limitState: newLimitState() };
}

const SECRET = 'the account email is jane@example.com';
const G = (over: Partial<Guardrails>): Guardrails => ({ ...DEFAULT_GUARDRAILS, ...over });
const FINAL_GUARD = G({ providers: ['pii'], targets: ['final_response'] });

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

describe('parallel: guards the aggregator output', () => {
  it('redacts PII the aggregator model emits', async () => {
    vi.spyOn(modelModule, 'buildModel').mockReturnValue({
      modelId: 'stub',
      route: { provider: 'anthropic', model: 'stub' } as const,
      async chat() {
        return { message: { role: 'assistant', content: SECRET }, stopReason: 'end_turn' };
      },
      streamChat: vi.fn(),
    } as never);
    const agent = buildParallelAgent({
      env: {} as Env,
      modelSpec: { id: null } as never,
      subAgents: { a: fixedAgent('part a'), b: fixedAgent('part b') },
      aggregatorPrompt: 'synthesize',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      guardrails: FINAL_GUARD,
    });
    const result = await runWithContext(ctx(), () =>
      agent.invoke({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(result.final.content).toContain('[REDACTED:email]');
    expect(result.final.content).not.toContain('jane@example.com');
  });

  it('leaves the aggregator output untouched when the guard is disabled', async () => {
    vi.spyOn(modelModule, 'buildModel').mockReturnValue({
      modelId: 'stub',
      route: { provider: 'anthropic', model: 'stub' } as const,
      async chat() {
        return { message: { role: 'assistant', content: SECRET }, stopReason: 'end_turn' };
      },
      streamChat: vi.fn(),
    } as never);
    const agent = buildParallelAgent({
      env: {} as Env,
      modelSpec: { id: null } as never,
      subAgents: { a: fixedAgent('part a') },
      aggregatorPrompt: 'synthesize',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      guardrails: G({ providers: ['pii'], targets: ['output'] }),
    });
    const result = await runWithContext(ctx(), () =>
      agent.invoke({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(result.final.content).toBe(SECRET);
  });
});

describe('groupchat: guards the returned answer', () => {
  it('redacts PII in the last speaker turn', async () => {
    const agent = buildGroupchatAgent({
      env: {} as Env,
      modelSpec: { id: null } as never,
      subAgents: { only: fixedAgent(SECRET) },
      moderatorPrompt: 'mod',
      maxTurns: 1,
      manifestId: 'm',
      manifestVersion: '1.0.0',
      guardrails: FINAL_GUARD,
    });
    const result = await runWithContext(ctx(), () =>
      agent.invoke({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(result.final.content).toContain('[REDACTED:email]');
    // The returned transcript tail matches the guarded final.
    expect(result.messages[result.messages.length - 1]!.content).toContain('[REDACTED:email]');
  });
});
