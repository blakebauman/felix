/**
 * BrowserExecutor — seventh tool transport.
 *
 * Pins:
 *   1. transport label is `'browser'`.
 *   2. Happy path: POSTs `{url, options, session?}` to `/{op}` on the
 *      bound Fetcher and returns the response body verbatim (HTML for
 *      `content`, base64 for binary ops — the wrapper Worker shapes
 *      the body, the executor doesn't reinterpret it).
 *   3. Non-2xx → soft-error ToolOutput with `codeForStatus` mapping.
 *   4. AbortSignal cancellation → soft-error `user_aborted`.
 *   5. `makeBrowserTool` fails the build when the named binding is
 *      missing on env.
 *   6. `ctx.threadId` is propagated as `session` so multi-turn flows
 *      can namespace browser sessions.
 *   7. `path_prefix` lands in the constructed URL.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserExecutor,
  type BrowserFetcher,
  makeBrowserTool,
} from '../../../src/tools/browser-executor';
import { readToolErrorCode, toolOutputContent } from '../../../src/tools/errors';

function fakeFetcher(handler: (req: Request) => Promise<Response>): BrowserFetcher {
  return {
    async fetch(input: RequestInfo, init?: RequestInit) {
      const req = new Request(input as string, init);
      return handler(req);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BrowserExecutor', () => {
  it("exposes transport label 'browser'", () => {
    const exec = new BrowserExecutor({
      binding: fakeFetcher(async () => new Response('', { status: 200 })),
      op: 'content',
    });
    expect(exec.transport).toBe('browser');
  });

  it('POSTs to /{op} and returns the response body verbatim', async () => {
    const captured: Array<{ url: string; body: string }> = [];
    const exec = new BrowserExecutor({
      binding: fakeFetcher(async (req) => {
        captured.push({ url: req.url, body: await req.text() });
        return new Response('<html><body>hi</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }),
      op: 'content',
    });
    const out = await exec.execute({ url: 'https://example.com' }, { threadId: 'tenant:thr-1' });
    expect(out).toBe('<html><body>hi</body></html>');
    expect(captured[0]!.url).toMatch(/\/content$/);
    const body = JSON.parse(captured[0]!.body);
    expect(body).toMatchObject({ url: 'https://example.com', session: 'tenant:thr-1' });
  });

  it('omits session when ctx.threadId is absent', async () => {
    let seen: Record<string, unknown> | null = null;
    const exec = new BrowserExecutor({
      binding: fakeFetcher(async (req) => {
        seen = JSON.parse(await req.text());
        return new Response('ok', { status: 200 });
      }),
      op: 'content',
    });
    await exec.execute({ url: 'https://example.com' });
    expect(seen).not.toHaveProperty('session');
  });

  it('non-2xx → soft-error mapped via codeForStatus', async () => {
    const exec = new BrowserExecutor({
      binding: fakeFetcher(async () => new Response('boom', { status: 502 })),
      op: 'content',
    });
    const out = await exec.execute({ url: 'https://example.com' });
    expect(toolOutputContent(out)).toContain('[browser error] content: 502');
    expect(toolOutputContent(out)).toContain('boom');
    expect(readToolErrorCode(out)).toBe('provider_error');
  });

  it('rate-limit (429) → rate_limited error code', async () => {
    const exec = new BrowserExecutor({
      binding: fakeFetcher(async () => new Response('slow', { status: 429 })),
      op: 'content',
    });
    const out = await exec.execute({ url: 'https://example.com' });
    expect(readToolErrorCode(out)).toBe('rate_limited');
  });

  it('AbortSignal → soft-error user_aborted', async () => {
    const exec = new BrowserExecutor({
      binding: fakeFetcher(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
      op: 'screenshot',
    });
    const controller = new AbortController();
    controller.abort(new DOMException('user cancelled', 'AbortError'));
    const out = await exec.execute({ url: 'https://example.com' }, { signal: controller.signal });
    expect(toolOutputContent(out)).toContain('[browser cancelled] screenshot:');
    expect(readToolErrorCode(out)).toBe('user_aborted');
  });

  it('honors path_prefix when constructing the fetch URL', async () => {
    const captured: string[] = [];
    const exec = new BrowserExecutor({
      binding: fakeFetcher(async (req) => {
        captured.push(req.url);
        return new Response('ok', { status: 200 });
      }),
      op: 'content',
      pathPrefix: '/browser',
    });
    await exec.execute({ url: 'https://example.com' });
    expect(captured[0]).toMatch(/\/browser\/content$/);
  });

  it('caps an oversized success body instead of buffering it unbounded', async () => {
    // A buggy/compromised adapter returns a body past the 8 MiB response cap.
    // The metered reader aborts and throws rather than OOMing the isolate.
    const huge = 'a'.repeat(8 * 1024 * 1024 + 64);
    const exec = new BrowserExecutor({
      binding: fakeFetcher(async () => new Response(huge, { status: 200 })),
      op: 'content',
    });
    await expect(exec.execute({ url: 'https://example.com' })).rejects.toThrow(/cap/);
  });

  it('treats an empty 200 body as a sentinel string', async () => {
    const exec = new BrowserExecutor({
      binding: fakeFetcher(async () => new Response('', { status: 200 })),
      op: 'content',
    });
    const out = await exec.execute({ url: 'https://example.com' });
    expect(out).toBe('[browser content returned empty body]');
  });
});

describe('makeBrowserTool', () => {
  it("fails the build when the named binding isn't on env", () => {
    expect(() =>
      makeBrowserTool({ name: 'fetch_page', binding: 'BROWSER_MISSING', op: 'content' }, {}),
    ).toThrow(/binding 'BROWSER_MISSING' which is not configured/);
  });

  it('builds a Tool with transport=browser when the binding is present', () => {
    const fetcher = fakeFetcher(async () => new Response('ok', { status: 200 }));
    const tool = makeBrowserTool(
      { name: 'fetch_page', binding: 'BROWSER', op: 'content' },
      { BROWSER: fetcher },
    );
    expect(tool.name).toBe('fetch_page');
    expect(tool.executor.transport).toBe('browser');
    expect(tool.source).toBe('browser:content');
  });

  it('tags the source with the op so audit can slice by op', () => {
    const fetcher = fakeFetcher(async () => new Response('ok', { status: 200 }));
    const screenshot = makeBrowserTool(
      { name: 'snap', binding: 'BROWSER', op: 'screenshot' },
      { BROWSER: fetcher },
    );
    expect(screenshot.source).toBe('browser:screenshot');
  });
});
