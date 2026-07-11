/**
 * OpenAI prompt-cache token accounting — pins the conversion from
 * OpenAI's wire format (where `cached_tokens` is a subset of
 * `prompt_tokens`) to our internal `TokenUsage` shape (where `input`,
 * `cache_read`, and `cache_creation` are disjoint, matching Anthropic).
 *
 * Regression guard: if `input` ever ends up storing the raw
 * `prompt_tokens` total, `recordUsage` will double-count cached tokens
 * against `LimitState.tokens.input` and trip `max_input_tokens` early
 * on cache-heavy conversations.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('OpenAI cache_read accounting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('subtracts cached_tokens from prompt_tokens on non-streamed responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1136,
            completion_tokens: 42,
            prompt_tokens_details: { cached_tokens: 1024 },
          },
        }),
      ),
    );
    const client = buildModel(fakeEnv(), modelSpec());
    const out = await client.chat([{ role: 'user', content: 'go' }], []);
    expect(out.usage).toEqual({
      input: 112, // 1136 - 1024
      output: 42,
      cache_read: 1024,
    });
    // Cross-provider invariant: input + cache_read = prompt_tokens.
    expect((out.usage?.input ?? 0) + (out.usage?.cache_read ?? 0)).toBe(1136);
  });

  it('subtracts cached_tokens from prompt_tokens on streamed responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            sse([
              {
                choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }],
              },
              {
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              },
              {
                choices: [],
                usage: {
                  prompt_tokens: 1136,
                  completion_tokens: 42,
                  prompt_tokens_details: { cached_tokens: 1024 },
                },
              },
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
    expect(result.usage).toEqual({
      input: 112,
      output: 42,
      cache_read: 1024,
    });
  });

  it('leaves input untouched when there is no cache hit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 500, completion_tokens: 10 },
        }),
      ),
    );
    const client = buildModel(fakeEnv(), modelSpec());
    const out = await client.chat([{ role: 'user', content: 'go' }], []);
    expect(out.usage).toEqual({ input: 500, output: 10 });
    expect(out.usage?.cache_read).toBeUndefined();
  });

  it('handles cached_tokens: 0 the same as absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 500,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
      ),
    );
    const client = buildModel(fakeEnv(), modelSpec());
    const out = await client.chat([{ role: 'user', content: 'go' }], []);
    expect(out.usage?.input).toBe(500);
    expect(out.usage?.cache_read).toBeUndefined();
  });
});
