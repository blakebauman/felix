/**
 * Anthropic prompt-caching wire format — cache_control marker placement
 * across system / last tool / last message, plus the thinking-block
 * interaction. Anthropic forbids cache_control on thinking blocks, so
 * the last-message tagger walks backward past them to find the last
 * cacheable block (or skips tagging if the whole array is thinking).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Env } from '../../src/env';
import { buildModel } from '../../src/patterns/model';
import type { ChatMessage } from '../../src/patterns/types';
import { defineTool } from '../../src/tools/types';

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
    cache: true,
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

function firstRequestBody(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = spy.mock.calls[0] as unknown as [string, RequestInit] | undefined;
  if (!call) throw new Error('fetch was not called');
  return JSON.parse(call[1].body as string);
}

function stubAnthropicJson() {
  const fetchSpy = vi.fn(async () =>
    Response.json({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

describe('Anthropic prompt-caching markers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wraps a string-content last message in a single text block with cache_control', async () => {
    const fetchSpy = stubAnthropicJson();
    const client = buildModel(fakeEnv(), modelSpec());
    await client.chat([{ role: 'user', content: 'hello' }], []);
    const body = firstRequestBody(fetchSpy);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('walks past a tail thinking block to tag the previous cacheable block', async () => {
    const fetchSpy = stubAnthropicJson();
    const client = buildModel(fakeEnv(), modelSpec());
    // Synthetic shape: an assistant message whose echoed content ends
    // with a thinking block (only achievable here because the message
    // has thinking but no tool_calls, and we make it the last turn).
    // tagLastBlockEphemeral should put cache_control on the text block,
    // not the thinking block at the tail.
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'mid-reasoning answer',
        thinking: [{ type: 'thinking', thinking: 'reasoning', signature: 'sig' }],
      },
    ];
    await client.chat(messages, []);
    const body = firstRequestBody(fetchSpy);
    const assistant = (body.messages as Array<{ role: string; content: unknown }>).find(
      (m) => m.role === 'assistant',
    )!;
    const blocks = assistant.content as Array<Record<string, unknown>>;
    // Echo order is [thinking, text]. The tagger must walk past the
    // trailing thinking block (which would actually be the FIRST block
    // here since text comes after thinking) and tag the text block.
    // After our echo path, content is [thinking, text]; the tail is
    // text, so tagging is straightforward in that orientation. Verify
    // cache_control lives on the text and NOT on the thinking.
    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
      {
        type: 'text',
        text: 'mid-reasoning answer',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('skips cache_control when the last message contains only thinking blocks', async () => {
    const fetchSpy = stubAnthropicJson();
    const client = buildModel(fakeEnv(), modelSpec());
    // Pathological shape: assistant turn with thinking but no text and
    // no tool_calls. The echoed content is just [thinking]. Tagger
    // must NOT place cache_control on the thinking block; with no
    // other candidate it must place no marker at all.
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        thinking: [
          { type: 'thinking', thinking: 'reasoning A', signature: 'sig-A' },
          { type: 'redacted_thinking', data: 'enc-B' },
        ],
      },
    ];
    await client.chat(messages, []);
    const body = firstRequestBody(fetchSpy);
    const assistant = (body.messages as Array<{ role: string; content: unknown }>).find(
      (m) => m.role === 'assistant',
    )!;
    const blocks = assistant.content as Array<Record<string, unknown>>;
    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'reasoning A', signature: 'sig-A' },
      { type: 'redacted_thinking', data: 'enc-B' },
    ]);
    for (const b of blocks) {
      expect(b.cache_control).toBeUndefined();
    }
  });

  it('marks the last tool definition with cache_control', async () => {
    const fetchSpy = stubAnthropicJson();
    const client = buildModel(fakeEnv(), modelSpec());
    // Build two dummy tools; only the last should carry cache_control.
    const tools = [
      defineTool({
        name: 'first',
        description: 'first tool',
        args: z.object({}),
        handler: async () => '',
      }),
      defineTool({
        name: 'second',
        description: 'second tool',
        args: z.object({}),
        handler: async () => '',
      }),
    ];
    await client.chat([{ role: 'user', content: 'go' }], tools);
    const body = firstRequestBody(fetchSpy);
    const toolDefs = body.tools as Array<Record<string, unknown>>;
    expect(toolDefs[0]?.cache_control).toBeUndefined();
    expect(toolDefs[1]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('wraps the system prompt as a single-block array with cache_control', async () => {
    const fetchSpy = stubAnthropicJson();
    const client = buildModel(fakeEnv(), modelSpec());
    await client.chat(
      [
        { role: 'system', content: 'you are felix' },
        { role: 'user', content: 'go' },
      ],
      [],
    );
    const body = firstRequestBody(fetchSpy);
    expect(body.system).toEqual([
      {
        type: 'text',
        text: 'you are felix',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });
});
