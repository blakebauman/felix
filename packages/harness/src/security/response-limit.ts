/**
 * Byte-bounded reads for outbound tool/peer/MCP responses.
 *
 * The SSRF guard controls *where* a transport connects, but nothing bounded
 * *how much* it read back: every transport did `resp.json()` / `resp.text()`
 * unbounded, so a hostile or compromised endpoint could return a multi-GB body
 * and exhaust the isolate's memory. `bodyLimit` only caps inbound request
 * bodies. `readCappedText` streams the response and aborts once the cap is
 * crossed, throwing a `ToolError('provider_error', …)` the executors already
 * know how to surface.
 */

import { ToolError } from '../tools/errors';

/** Default ceiling for a single outbound tool response body. */
export const MAX_TOOL_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MiB

/**
 * Read a response body as text, aborting once `maxBytes` is exceeded. Returns
 * '' for an empty/absent body. Throws `ToolError('provider_error', …)` when the
 * cap is crossed so the caller doesn't buffer an unbounded body into memory.
 */
export async function readCappedText(
  resp: Response,
  maxBytes: number = MAX_TOOL_RESPONSE_BYTES,
): Promise<string> {
  const body = resp.body;
  if (!body) {
    // No stream to meter (e.g. a mocked/empty response) — fall back to the
    // built-in text() which is already realized in memory.
    return resp.text();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ToolError('provider_error', `response body exceeded the ${maxBytes}-byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Read a JSON response with the same byte cap, parsing the capped text. */
export async function readCappedJson<T>(resp: Response, maxBytes?: number): Promise<T> {
  const text = await readCappedText(resp, maxBytes);
  return JSON.parse(text) as T;
}
