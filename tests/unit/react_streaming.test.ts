/**
 * react.streamEvents now consumes the final ModelChatResult returned by
 * `streamChat` (no second `chat()` call). These tests pin the contract:
 *
 *   1. text deltas are forwarded as on_chat_model_stream events,
 *   2. tool_calls returned from the streaming generator are dispatched,
 *   3. token usage on the result is accumulated into LimitState.
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

const echo = defineTool({
  name: 'echo',
  description: 'echo',
  args: z.object({ text: z.string() }),
  handler: async ({ text }) => text,
});

function fakeStreamingModel(opts: {
  deltas: string[];
  finalMessage: ChatMessage;
  stopReason?: 'end_turn' | 'tool_use';
  usage?: { input: number; output: number };
}) {
  return {
    modelId: 'stub',
    route: { provider: 'anthropic', model: 'stub' } as const,
    async chat() {
      throw new Error('streaming test should not call chat()');
    },
    async *streamChat() {
      for (const d of opts.deltas) yield d;
      return {
        message: opts.finalMessage,
        stopReason: opts.stopReason ?? 'end_turn',
        ...(opts.usage ? { usage: opts.usage } : {}),
      };
    },
  };
}

describe('react streamEvents', () => {
  it('forwards text deltas and consumes the streamed final result', async () => {
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(
      fakeStreamingModel({
        deltas: ['Hello, ', 'world.'],
        finalMessage: { role: 'assistant', content: 'Hello, world.' },
      }) as never,
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
      tools: [echo],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
    });
    const events: string[] = [];
    let finalContent = '';
    await runWithContext(ctx(), async () => {
      for await (const ev of agent.streamEvents({ messages: [{ role: 'user', content: 'hi' }] })) {
        if (ev.event === 'on_chat_model_stream') events.push(ev.data.chunk.content);
        if (ev.event === 'on_chain_end') finalContent = ev.data.output.final.content;
      }
    });
    expect(events).toEqual(['Hello, ', 'world.']);
    expect(finalContent).toBe('Hello, world.');
  });

  it('accumulates token usage into LimitState', async () => {
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(
      fakeStreamingModel({
        deltas: ['hi'],
        finalMessage: { role: 'assistant', content: 'hi' },
        usage: { input: 12, output: 3 },
      }) as never,
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
      tools: [echo],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
    });
    const c = ctx();
    await runWithContext(c, async () => {
      for await (const _ of agent.streamEvents({
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        void _;
      }
    });
    expect(c.limitState.tokens.input).toBe(12);
    expect(c.limitState.tokens.output).toBe(3);
  });

  it('dispatches tool_calls from the streamed final result', async () => {
    const responses: Array<ReturnType<typeof fakeStreamingModel>> = [
      fakeStreamingModel({
        deltas: [''],
        finalMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'tc1', name: 'echo', args: { text: 'streamed' } }],
        },
        stopReason: 'tool_use',
      }),
      fakeStreamingModel({
        deltas: ['ok'],
        finalMessage: { role: 'assistant', content: 'ok' },
      }),
    ];
    let i = 0;
    vi.spyOn(modelModule, 'buildModel').mockReturnValue({
      modelId: 'stub',
      route: { provider: 'anthropic', model: 'stub' } as const,
      async chat() {
        throw new Error('not used');
      },
      async *streamChat() {
        const m = responses[i++]!;
        // Hand-roll delegation: `yield*` does propagate the return value
        // in TS, but only when typed as `AsyncGenerator<T, R>`. Iterating
        // explicitly avoids depending on that narrowing here.
        const iter = m.streamChat();
        while (true) {
          const next = await iter.next();
          if (next.done) return next.value;
          yield next.value;
        }
      },
    } as never);
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
      tools: [echo],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
    });
    const tools: string[] = [];
    let finalContent = '';
    await runWithContext(ctx(), async () => {
      for await (const ev of agent.streamEvents({ messages: [{ role: 'user', content: 'go' }] })) {
        if (ev.event === 'on_tool_end') tools.push(ev.data.output);
        if (ev.event === 'on_chain_end') finalContent = ev.data.output.final.content;
      }
    });
    expect(tools).toEqual(['streamed']);
    expect(finalContent).toBe('ok');
  });
});
