import { describe, expect, it } from 'vitest';
import {
  MAX_TOOL_RESPONSE_BYTES,
  readCappedJson,
  readCappedText,
} from '../../src/security/response-limit';
import { ToolError } from '../../src/tools/errors';

function streamResponse(bytes: Uint8Array): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Emit in small chunks so the cap is enforced mid-stream, not just on
      // the first read.
      const chunkSize = 64 * 1024;
      for (let i = 0; i < bytes.byteLength; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream);
}

describe('readCappedText / readCappedJson', () => {
  it('reads a small body in full', async () => {
    const text = await readCappedText(new Response('hello world'));
    expect(text).toBe('hello world');
  });

  it('parses JSON within the cap', async () => {
    const obj = await readCappedJson<{ a: number }>(new Response(JSON.stringify({ a: 1 })));
    expect(obj.a).toBe(1);
  });

  it('throws a provider_error ToolError when the body exceeds the cap', async () => {
    const big = new Uint8Array(1024 + 10).fill(65); // 1034 bytes
    await expect(readCappedText(streamResponse(big), 1024)).rejects.toBeInstanceOf(ToolError);
    await expect(readCappedText(streamResponse(big), 1024)).rejects.toMatchObject({
      code: 'provider_error',
    });
  });

  it('allows a body exactly at the cap', async () => {
    const exact = new Uint8Array(1024).fill(66);
    const text = await readCappedText(streamResponse(exact), 1024);
    expect(text.length).toBe(1024);
  });

  it('exposes a sane default ceiling', () => {
    expect(MAX_TOOL_RESPONSE_BYTES).toBeGreaterThan(1024 * 1024);
  });
});
