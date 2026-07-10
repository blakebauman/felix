/**
 * Anthropic SSE parsing — pin the wire format.
 *
 * The streaming client builds a ModelChatResult from a sequence of
 * `message_start` (input tokens), `content_block_*` (text deltas + tool_use
 * with input_json_delta), and `message_delta` (output tokens + stop_reason)
 * events. This test feeds canned SSE bytes through the real client and
 * checks the assembled result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import { buildModel } from '../../src/patterns/model';

function sse(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const ev of events) {
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
      ctrl.close();
    },
  });
}

function fakeEnv(): Env {
  return {
    AI_GATEWAY_ACCOUNT_ID: 'acct',
    AI_GATEWAY_SLUG: 'slug',
    ANTHROPIC_API_KEY: 'k',
    DEFAULT_MODEL_ID: 'claude-sonnet-4',
    MODEL_ROUTES: JSON.stringify({
      'claude-sonnet-4': { provider: 'anthropic', model: 'claude-sonnet-4' },
    }),
  } as unknown as Env;
}

describe('Anthropic streaming SSE parser', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            sse([
              { type: 'message_start', message: { usage: { input_tokens: 42, output_tokens: 1 } } },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: ' there' },
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'content_block_start',
                index: 1,
                content_block: { type: 'tool_use', id: 'toolu_01', name: 'echo' },
              },
              {
                type: 'content_block_delta',
                index: 1,
                delta: { type: 'input_json_delta', partial_json: '{"text":' },
              },
              {
                type: 'content_block_delta',
                index: 1,
                delta: { type: 'input_json_delta', partial_json: '"hello"}' },
              },
              { type: 'content_block_stop', index: 1 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use' },
                usage: { output_tokens: 17 },
              },
              { type: 'message_stop' },
            ]),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('assembles text deltas, tool_use blocks, and usage from streamed SSE', async () => {
    const client = buildModel(fakeEnv(), {
      id: 'claude-sonnet-4',
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
    });
    const stream = client.streamChat([{ role: 'user', content: 'go' }], []);
    const yielded: string[] = [];
    let result: Awaited<ReturnType<typeof stream.next>>['value'];
    while (true) {
      const next = await stream.next();
      if (next.done) {
        result = next.value;
        break;
      }
      yielded.push(next.value);
    }
    expect(yielded.join('')).toBe('Hi there');
    expect(result).toBeDefined();
    if (!result || typeof result === 'string') throw new Error('expected ModelChatResult');
    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toBe('Hi there');
    expect(result.message.tool_calls).toEqual([
      { id: 'toolu_01', name: 'echo', args: { text: 'hello' } },
    ]);
    expect(result.stopReason).toBe('tool_use');
    expect(result.usage).toEqual({ input: 42, output: 17 });
  });

  it('flushes a trailing event when the stream closes without a final blank line', async () => {
    // Simulate a clean close after the last `data:` line but before the
    // closing `\n\n`. The parser must flush `buf` so that final event's
    // payload (here, the message_delta carrying output_tokens) still
    // lands in the result.
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
          ),
        );
        ctrl.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            })}\n\n`,
          ),
        );
        ctrl.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'tail' },
            })}\n\n`,
          ),
        );
        ctrl.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 11 },
            })}\n`,
          ),
        );
        // Note: NO trailing `\n` — final event lacks its closing blank line.
        ctrl.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      ),
    );
    const client = buildModel(fakeEnv(), {
      id: 'claude-sonnet-4',
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
    });
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
    expect(yielded.join('')).toBe('tail');
    if (!result || typeof result === 'string') throw new Error('expected ModelChatResult');
    expect(result.usage).toEqual({ input: 1, output: 11 });
    expect(result.stopReason).toBe('end_turn');
  });
});
