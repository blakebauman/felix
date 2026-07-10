/**
 * Multimodal (vision) input wire format — `ChatMessage.attachments` mapped to
 * provider-native image blocks. Anthropic: `image` blocks (base64 / url source)
 * placed *before* the text block. OpenAI: `image_url` parts placed *after* the
 * text part. Malformed / non-image-URL attachments are dropped. Providers
 * without vision (Workers AI) are unaffected — covered by leaving text-only
 * mapping untouched elsewhere.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import { buildModel } from '../../src/patterns/model';
import type { ChatMessage } from '../../src/patterns/types';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function anthropicEnv(): Env {
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

function openaiEnv(): Env {
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

// cache:false so the content arrays stay pristine (no cache_control tagging).
function modelSpec(id: string) {
  return {
    id,
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

function stubOpenAIJson() {
  const fetchSpy = vi.fn(async () =>
    Response.json({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

describe('multimodal vision — Anthropic image blocks', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps a base64 data-URL attachment to an image block before the text', async () => {
    const fetchSpy = stubAnthropicJson();
    const client = buildModel(anthropicEnv(), modelSpec('claude-sonnet-4'));
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: "what's in this image?",
        attachments: [{ url: PNG_DATA_URL, media_type: 'image/png', filename: 'a.png' }],
      },
    ];
    await client.chat(messages, []);
    const body = firstRequestBody(fetchSpy);
    const content = (body.messages as Array<{ content: unknown }>)[0]?.content;
    expect(content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
      },
      { type: 'text', text: "what's in this image?" },
    ]);
  });

  it('maps an https URL attachment to a url image source', async () => {
    const fetchSpy = stubAnthropicJson();
    const client = buildModel(anthropicEnv(), modelSpec('claude-sonnet-4'));
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'describe',
        attachments: [{ url: 'https://example.com/cat.jpg', media_type: 'image/jpeg' }],
      },
    ];
    await client.chat(messages, []);
    const body = firstRequestBody(fetchSpy);
    const content = (body.messages as Array<{ content: unknown }>)[0]?.content;
    expect(content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.com/cat.jpg' } },
      { type: 'text', text: 'describe' },
    ]);
  });

  it('drops malformed attachments and keeps a plain string when none survive', async () => {
    const fetchSpy = stubAnthropicJson();
    const client = buildModel(anthropicEnv(), modelSpec('claude-sonnet-4'));
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'hello',
        attachments: [{ url: 'ftp://nope', media_type: 'image/png' }],
      },
    ];
    await client.chat(messages, []);
    const body = firstRequestBody(fetchSpy);
    const content = (body.messages as Array<{ content: unknown }>)[0]?.content;
    // No surviving image blocks → text-only content array.
    expect(content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('leaves text-only user messages as a plain string', async () => {
    const fetchSpy = stubAnthropicJson();
    const client = buildModel(anthropicEnv(), modelSpec('claude-sonnet-4'));
    await client.chat([{ role: 'user', content: 'just text' }], []);
    const body = firstRequestBody(fetchSpy);
    const content = (body.messages as Array<{ content: unknown }>)[0]?.content;
    expect(content).toBe('just text');
  });
});

describe('multimodal vision — OpenAI image_url parts', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps attachments to image_url parts after the text part', async () => {
    const fetchSpy = stubOpenAIJson();
    const client = buildModel(openaiEnv(), modelSpec('gpt-4o'));
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'caption this',
        attachments: [{ url: PNG_DATA_URL, media_type: 'image/png' }],
      },
    ];
    await client.chat(messages, []);
    const body = firstRequestBody(fetchSpy);
    const content = (body.messages as Array<{ content: unknown }>)[0]?.content;
    expect(content).toEqual([
      { type: 'text', text: 'caption this' },
      { type: 'image_url', image_url: { url: PNG_DATA_URL } },
    ]);
  });
});
