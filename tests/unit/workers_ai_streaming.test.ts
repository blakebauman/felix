/**
 * Workers AI SSE parser — pin the buffered-line-reader behavior.
 *
 * The binding's stream returns chunks split at arbitrary byte
 * boundaries (TextDecoderStream doesn't realign on newlines), so the
 * parser must buffer partial lines across reads. Without that, a
 * chunk that ends mid-`data:` line drops content silently.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { buildModel } from '../../src/patterns/model';

function buildEnv(stream: ReadableStream<Uint8Array>): Env {
  return {
    DEFAULT_MODEL_ID: 'llama-3.3-70b',
    MODEL_ROUTES: JSON.stringify({
      'llama-3.3-70b': {
        provider: 'workers-ai',
        model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      },
    }),
    AI: {
      // The model client calls env.AI.run(model, { ..., stream: true })
      // and expects a ReadableStream back when streaming is requested.
      run: async () => stream,
    },
  } as unknown as Env;
}

function modelSpec() {
  return {
    id: 'llama-3.3-70b',
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

function streamOfBytes(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const chunk of chunks) ctrl.enqueue(enc.encode(chunk));
      ctrl.close();
    },
  });
}

describe('Workers AI streaming SSE parser', () => {
  afterEach(() => {
    // No globals stubbed — env is per-test.
  });

  it('reassembles content when a chunk boundary splits a `data:` line mid-payload', async () => {
    // Split the second SSE event so its `data:` line straddles two
    // chunks. The parser must buffer until the newline closes the
    // line. Without buffering, the second token (" world") is lost
    // entirely — the first chunk ends with unparseable JSON and the
    // second chunk's leading fragment is skipped because it doesn't
    // start with `data: `.
    const stream = streamOfBytes([
      'data: {"response": "Hello"}\ndata: {"resp',
      'onse": " world"}\ndata: {"response": "!"}\ndata: [DONE]\n',
    ]);
    const client = buildModel(buildEnv(stream), modelSpec());
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
    expect(yielded.join('')).toBe('Hello world!');
    if (!result || typeof result === 'string') throw new Error('expected ModelChatResult');
    expect(result.message.content).toBe('Hello world!');
  });

  it('captures usage emitted across a chunk-split boundary', async () => {
    // Usage JSON straddles two chunks. Without buffering, the JSON
    // never parses and the usage block is dropped.
    const stream = streamOfBytes([
      'data: {"response": "ok"}\ndata: {"usage": {"prompt_tokens": 5, "complet',
      'ion_tokens": 3}}\ndata: [DONE]\n',
    ]);
    const client = buildModel(buildEnv(stream), modelSpec());
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
    expect(result.usage).toEqual({ input: 5, output: 3 });
  });

  it('flushes a trailing line that lacks a final newline', async () => {
    // Some streams close without a final `\n` after the last event.
    // The parser must flush `buf` once the read returns done.
    const stream = streamOfBytes(['data: {"response": "tail"}']);
    const client = buildModel(buildEnv(stream), modelSpec());
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
    expect(result.message.content).toBe('tail');
  });

  it('passes through cleanly when every chunk aligns to line boundaries', async () => {
    // Sanity check: the buffered path doesn't regress the easy case.
    const stream = streamOfBytes([
      'data: {"response": "a"}\n',
      'data: {"response": "b"}\n',
      'data: [DONE]\n',
    ]);
    const client = buildModel(buildEnv(stream), modelSpec());
    const gen = client.streamChat([{ role: 'user', content: 'go' }], []);
    const yielded: string[] = [];
    while (true) {
      const next = await gen.next();
      if (next.done) break;
      yielded.push(next.value);
    }
    expect(yielded.join('')).toBe('ab');
  });
});
