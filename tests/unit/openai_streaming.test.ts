/**
 * OpenAI SSE parser — pin streaming behavior, especially the buffered
 * line-reader's tolerance of a stream that closes without a closing
 * blank line on the final event.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import { buildModel } from '../../src/patterns/model';

function fakeEnv(): Env {
  return {
    AI_GATEWAY_ACCOUNT_ID: 'acct',
    AI_GATEWAY_SLUG: 'slug',
    OPENAI_API_KEY: 'k',
    DEFAULT_MODEL_ID: 'gpt-4o',
    MODEL_ROUTES: JSON.stringify({
      'gpt-4o': { provider: 'openai', model: 'gpt-4o' },
    }),
  } as unknown as Env;
}

function modelSpec() {
  return {
    id: 'gpt-4o',
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
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const ev of events) ctrl.enqueue(enc.encode(ev));
      ctrl.close();
    },
  });
}

describe('OpenAI streaming SSE parser', () => {
  beforeEach(() => {
    // Each test stubs fetch locally.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('assembles content deltas, tool_calls, and usage across normal SSE events', async () => {
    const events = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hi' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: ' there' } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call_01', function: { name: 'echo', arguments: '' } }],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] } },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(streamOf(events), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );
    const client = buildModel(fakeEnv(), modelSpec());
    const gen = client.streamChat([{ role: 'user', content: 'go' }], []);
    const yielded: string[] = [];
    let result: Awaited<ReturnType<typeof gen.next>>['value'];
    while (true) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      yielded.push(next.value);
    }
    expect(yielded.join('')).toBe('Hi there');
    if (!result || typeof result === 'string') throw new Error('expected ModelChatResult');
    expect(result.message.content).toBe('Hi there');
    expect(result.message.tool_calls).toEqual([{ id: 'call_01', name: 'echo', args: { x: 1 } }]);
    expect(result.stopReason).toBe('tool_use');
    expect(result.usage).toEqual({ input: 12, output: 4 });
  });

  it('flushes a trailing event when the stream closes without a final blank line', async () => {
    // Final usage chunk arrives with `\n` instead of `\n\n` and the
    // stream closes. The parser must flush `buf` to capture it.
    const events = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'tail' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n`,
      // No trailing `\n` and no [DONE] — pretend the connection closed cleanly here.
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(streamOf(events), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );
    const client = buildModel(fakeEnv(), modelSpec());
    const gen = client.streamChat([{ role: 'user', content: 'go' }], []);
    let result: Awaited<ReturnType<typeof gen.next>>['value'];
    while (true) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }
    if (!result || typeof result === 'string') throw new Error('expected ModelChatResult');
    expect(result.message.content).toBe('tail');
    expect(result.usage).toEqual({ input: 7, output: 2 });
  });
});
