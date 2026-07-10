/**
 * Extended-thinking block handling — capture from streamed/non-streamed
 * Anthropic responses, and verbatim echo on subsequent requests.
 *
 * The integrity check Anthropic enforces on continuations means both
 * regular `thinking` blocks (text + signature) and `redacted_thinking`
 * blocks (encrypted `data` blob) must round-trip unchanged, in the
 * original block order, before any text / tool_use blocks.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import { buildModel } from '../../src/patterns/model';
import type { ChatMessage } from '../../src/patterns/types';

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

function modelSpec() {
  return {
    id: 'claude-sonnet-4',
    temperature: 0,
    max_tokens: null,
    region: null,
    cache: false,
    thinking_budget: 1024,
    fallbacks: [] as string[],
    confidence_escalation: {
      enabled: false,
      escalate_to: '',
      low_confidence_markers: [],
      min_response_chars: 40,
    },
  };
}

function firstRequestBody(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = spy.mock.calls[0] as unknown as [string, RequestInit] | undefined;
  if (!call) throw new Error('fetch was not called');
  return JSON.parse(call[1].body as string);
}

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

describe('extended-thinking block round-trip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('captures thinking + redacted_thinking from streamed SSE in original order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            sse([
              {
                type: 'message_start',
                message: { usage: { input_tokens: 10, output_tokens: 1 } },
              },
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '', signature: '' },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'Let me think...' },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'signature_delta', signature: 'sig-A' },
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'content_block_start',
                index: 1,
                content_block: { type: 'redacted_thinking', data: 'enc-blob-B' },
              },
              { type: 'content_block_stop', index: 1 },
              {
                type: 'content_block_start',
                index: 2,
                content_block: { type: 'tool_use', id: 'toolu_01', name: 'echo' },
              },
              {
                type: 'content_block_delta',
                index: 2,
                delta: { type: 'input_json_delta', partial_json: '{}' },
              },
              { type: 'content_block_stop', index: 2 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use' },
                usage: { output_tokens: 5 },
              },
              { type: 'message_stop' },
            ]),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );
    const client = buildModel(fakeEnv(), modelSpec());
    const stream = client.streamChat([{ role: 'user', content: 'go' }], []);
    let result: Awaited<ReturnType<typeof stream.next>>['value'];
    while (true) {
      const next = await stream.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }
    if (!result || typeof result === 'string') throw new Error('expected ModelChatResult');
    expect(result.message.thinking).toEqual([
      { type: 'thinking', thinking: 'Let me think...', signature: 'sig-A' },
      { type: 'redacted_thinking', data: 'enc-blob-B' },
    ]);
  });

  it('captures redacted_thinking from non-streamed response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          content: [
            { type: 'thinking', thinking: 'ok', signature: 'sig-A' },
            { type: 'redacted_thinking', data: 'enc-blob-B' },
            { type: 'text', text: 'done' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      ),
    );
    const client = buildModel(fakeEnv(), modelSpec());
    const out = await client.chat([{ role: 'user', content: 'go' }], []);
    expect(out.message.thinking).toEqual([
      { type: 'thinking', thinking: 'ok', signature: 'sig-A' },
      { type: 'redacted_thinking', data: 'enc-blob-B' },
    ]);
  });

  it('echoes both block types before tool_use on a continuation request', async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        content: [{ type: 'text', text: 'continued' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const client = buildModel(fakeEnv(), modelSpec());
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        thinking: [
          { type: 'thinking', thinking: 'Let me think...', signature: 'sig-A' },
          { type: 'redacted_thinking', data: 'enc-blob-B' },
        ],
        tool_calls: [{ id: 'toolu_01', name: 'echo', args: { text: 'hi' } }],
      },
      { role: 'tool', content: 'hi', tool_call_id: 'toolu_01', name: 'echo' },
    ];
    await client.chat(messages, []);
    const body = firstRequestBody(fetchSpy);
    const assistantMsg = (body.messages as Array<{ role: string; content: unknown }>).find(
      (m) => m.role === 'assistant',
    )!;
    expect(assistantMsg.content).toEqual([
      { type: 'thinking', thinking: 'Let me think...', signature: 'sig-A' },
      { type: 'redacted_thinking', data: 'enc-blob-B' },
      { type: 'tool_use', id: 'toolu_01', name: 'echo', input: { text: 'hi' } },
    ]);
  });

  it('echoes thinking blocks on assistant turns that have no tool_calls', async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        content: [{ type: 'text', text: 'next' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const client = buildModel(fakeEnv(), modelSpec());
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'sure',
        thinking: [{ type: 'thinking', thinking: 'reasoning', signature: 'sig-X' }],
      },
      { role: 'user', content: 'follow-up' },
    ];
    await client.chat(messages, []);
    const body = firstRequestBody(fetchSpy);
    const assistantMsg = (body.messages as Array<{ role: string; content: unknown }>).find(
      (m) => m.role === 'assistant',
    )!;
    expect(assistantMsg.content).toEqual([
      { type: 'thinking', thinking: 'reasoning', signature: 'sig-X' },
      { type: 'text', text: 'sure' },
    ]);
  });
});
