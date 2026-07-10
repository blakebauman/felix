/**
 * Tools marked `fatal: true` terminate the react loop instead of having
 * their error stringified and fed back to the model. This pins the
 * dispatchToolCall contract:
 *
 *   - default: tool throw → `[tool error/<code>] ...` returned to the
 *     model, loop continues. <code> is derived via `inferErrorCode`.
 *   - fatal: tool throw → loop returns with the fatal tool message as
 *     `final`, no further model turn.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import * as modelModule from '../../src/patterns/model';
import { buildReactAgent } from '../../src/patterns/react';
import type { ChatMessage } from '../../src/patterns/types';
import { defineTool } from '../../src/tools/types';

function ctx(): RequestContext {
  return { env: {} as Env, auth: ANONYMOUS, limitState: newLimitState() };
}

function fakeModel(responses: ChatMessage[]) {
  return {
    modelId: 'stub',
    route: { provider: 'anthropic', model: 'stub' } as const,
    async chat() {
      const next = responses.shift();
      if (!next) throw new Error('out of stubbed responses');
      const stopReason = next.tool_calls?.length ? 'tool_use' : 'end_turn';
      return { message: next, stopReason: stopReason as 'tool_use' | 'end_turn' };
    },
    async *streamChat() {},
  };
}

const fatalTool = defineTool({
  name: 'critical',
  description: 'fails the loop on error',
  args: z.object({}),
  fatal: true,
  handler: async () => {
    throw new Error('hard stop');
  },
});

const recoverableTool = defineTool({
  name: 'soft',
  description: 'failures are recoverable',
  args: z.object({}),
  handler: async () => {
    throw new Error('soft fail');
  },
});

describe('react fatal tool errors', () => {
  it('terminates the loop when a fatal tool throws', async () => {
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(
      fakeModel([
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'tc1', name: 'critical', args: {} }],
        },
        // This second response should never be requested — the loop must
        // terminate after the fatal tool runs.
      ]) as never,
    );
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
      tools: [fatalTool],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
    });
    const result = await runWithContext(ctx(), async () =>
      agent.invoke({ messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(result.final.role).toBe('tool');
    expect(result.final.content).toMatch(/\[tool error\/[a-z_]+\] hard stop/);
  });

  it('continues the loop on a non-fatal tool error', async () => {
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(
      fakeModel([
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'tc1', name: 'soft', args: {} }],
        },
        { role: 'assistant', content: 'recovered' },
      ]) as never,
    );
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
      tools: [recoverableTool],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
    });
    const result = await runWithContext(ctx(), async () =>
      agent.invoke({ messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(result.final.role).toBe('assistant');
    expect(result.final.content).toBe('recovered');
  });
});
