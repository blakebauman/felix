/**
 * The final-response guard wired into the react loop. Pins:
 *   - non-streaming invoke: the returned `final` is redacted.
 *   - streaming `buffer`: raw PII deltas are NOT emitted; the guarded answer is
 *     emitted as a single chunk once the stream completes.
 *   - streaming `passthrough`: raw deltas stream unfiltered, but the terminal
 *     `on_chain_end` message is still guarded.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { DEFAULT_GUARDRAILS, type Guardrails } from '../../src/guardrails/models';
import * as modelModule from '../../src/patterns/model';
import { buildReactAgent } from '../../src/patterns/react';
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

const MODEL_SPEC = {
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
} as const;

const SECRET = 'here is my ssn 123-45-6789 ok';

function fakeStreamingModel(deltas: string[], finalContent: string) {
  return {
    modelId: 'stub',
    route: { provider: 'anthropic', model: 'stub' } as const,
    async chat() {
      return { message: { role: 'assistant', content: finalContent }, stopReason: 'end_turn' };
    },
    async *streamChat() {
      for (const d of deltas) yield d;
      return { message: { role: 'assistant', content: finalContent }, stopReason: 'end_turn' };
    },
  };
}

function agentWith(guardrails: Guardrails) {
  return buildReactAgent({
    env: {} as Env,
    modelSpec: MODEL_SPEC as never,
    tools: [echo],
    systemPrompt: 'sp',
    manifestId: 'm',
    manifestVersion: '1.0.0',
    guardrails,
  });
}

const G = (over: Partial<Guardrails>): Guardrails => ({ ...DEFAULT_GUARDRAILS, ...over });

describe('final-response guard in the react loop', () => {
  it('redacts the returned final on the non-streaming path', async () => {
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(fakeStreamingModel([], SECRET) as never);
    const agent = agentWith(G({ providers: ['pii'], targets: ['output', 'final_response'] }));
    const result = await runWithContext(ctx(), () =>
      agent.invoke({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(result.final.content).toContain('[REDACTED:ssn]');
    expect(result.final.content).not.toContain('123-45-6789');
  });

  it('buffer mode: withholds raw PII deltas and emits the guarded answer once', async () => {
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(
      fakeStreamingModel(['here is my ssn ', '123-45-6789 ok'], SECRET) as never,
    );
    const agent = agentWith(
      G({
        providers: ['pii'],
        targets: ['final_response'],
        final_response: { on_match: 'redact', streaming: 'buffer' },
      }),
    );
    const chunks: string[] = [];
    let finalContent = '';
    await runWithContext(ctx(), async () => {
      for await (const ev of agent.streamEvents({ messages: [{ role: 'user', content: 'hi' }] })) {
        if (ev.event === 'on_chat_model_stream') chunks.push(ev.data.chunk.content);
        if (ev.event === 'on_chain_end') finalContent = ev.data.output.final.content;
      }
    });
    // No raw SSN ever streamed to the client.
    expect(chunks.join('')).not.toContain('123-45-6789');
    // The guarded answer was emitted as a single chunk.
    expect(chunks).toEqual([expect.stringContaining('[REDACTED:ssn]')]);
    expect(finalContent).toContain('[REDACTED:ssn]');
  });

  it('passthrough mode: streams raw deltas but guards the terminal message', async () => {
    const deltas = ['here is my ssn ', '123-45-6789 ok'];
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(
      fakeStreamingModel(deltas, SECRET) as never,
    );
    const agent = agentWith(
      G({
        providers: ['pii'],
        targets: ['final_response'],
        final_response: { on_match: 'redact', streaming: 'passthrough' },
      }),
    );
    const chunks: string[] = [];
    let finalContent = '';
    await runWithContext(ctx(), async () => {
      for await (const ev of agent.streamEvents({ messages: [{ role: 'user', content: 'hi' }] })) {
        if (ev.event === 'on_chat_model_stream') chunks.push(ev.data.chunk.content);
        if (ev.event === 'on_chain_end') finalContent = ev.data.output.final.content;
      }
    });
    // Raw deltas streamed as-is (the documented passthrough tradeoff)…
    expect(chunks).toEqual(deltas);
    // …but the persisted/returned terminal message is guarded.
    expect(finalContent).toContain('[REDACTED:ssn]');
  });

  it('disabled: streams and returns the raw answer unchanged', async () => {
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(
      fakeStreamingModel(['plain ', 'answer'], 'plain answer') as never,
    );
    const agent = agentWith(G({ providers: ['pii'], targets: ['output'] }));
    const chunks: string[] = [];
    await runWithContext(ctx(), async () => {
      for await (const ev of agent.streamEvents({ messages: [{ role: 'user', content: 'hi' }] })) {
        if (ev.event === 'on_chat_model_stream') chunks.push(ev.data.chunk.content);
      }
    });
    expect(chunks).toEqual(['plain ', 'answer']);
  });
});
