/**
 * SandboxExecutor — sixth tool transport, sibling to local / mcp / a2a /
 * container / queue.
 *
 * Pins:
 *   1. transport label is `'sandbox'`.
 *   2. Happy path: POSTs `{tool, arguments, session?}` to `/exec` on the
 *      bound Fetcher and returns the response `content`.
 *   3. Non-2xx → soft-error ToolOutput with `codeForStatus` mapping
 *      (provider_error / rate_limited / invalid_arguments / etc).
 *   4. Non-zero exit_code → soft-error with `provider_error` code.
 *   5. AbortSignal cancellation → soft-error with `user_aborted` code.
 *   6. `makeSandboxTool` fails the build when the named binding is
 *      missing on env (fail-fast, never silent no-op).
 *   7. `ctx.threadId` is propagated to the sandbox as `session` so a
 *      multi-turn conversation can namespace its filesystem state.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readToolErrorCode, toolOutputContent } from '../../../src/tools/errors';
import {
  makeSandboxTool,
  SandboxExecutor,
  type SandboxFetcher,
} from '../../../src/tools/sandbox-executor';

function fakeFetcher(handler: (req: Request) => Promise<Response>): SandboxFetcher {
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

describe('SandboxExecutor', () => {
  it("exposes transport label 'sandbox'", () => {
    const exec = new SandboxExecutor({
      binding: fakeFetcher(async () => new Response('{}', { status: 200 })),
      sandboxToolName: 'python_runner',
    });
    expect(exec.transport).toBe('sandbox');
  });

  it('POSTs {tool, arguments, session} to /exec and returns content on success', async () => {
    const captured: Array<{ url: string; method: string; body: string }> = [];
    const exec = new SandboxExecutor({
      binding: fakeFetcher(async (req) => {
        captured.push({
          url: req.url,
          method: req.method,
          body: await req.text(),
        });
        return new Response(JSON.stringify({ content: 'pong' }), { status: 200 });
      }),
      sandboxToolName: 'eval',
    });
    const out = await exec.execute({ expr: '2+2' }, { threadId: 'tenant:thr-1' });
    expect(out).toBe('pong');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('POST');
    expect(captured[0]!.url).toMatch(/\/exec$/);
    const body = JSON.parse(captured[0]!.body);
    expect(body).toEqual({
      tool: 'eval',
      arguments: { expr: '2+2' },
      session: 'tenant:thr-1',
    });
  });

  it('omits session when ctx.threadId is absent', async () => {
    let seen: Record<string, unknown> | null = null;
    const exec = new SandboxExecutor({
      binding: fakeFetcher(async (req) => {
        seen = JSON.parse(await req.text());
        return new Response(JSON.stringify({ content: 'ok' }), { status: 200 });
      }),
      sandboxToolName: 'eval',
    });
    await exec.execute({});
    expect(seen).not.toHaveProperty('session');
  });

  it('non-2xx → soft-error with codeForStatus mapping', async () => {
    const exec = new SandboxExecutor({
      binding: fakeFetcher(async () => new Response('boom', { status: 503 })),
      sandboxToolName: 'eval',
    });
    const out = await exec.execute({});
    expect(toolOutputContent(out)).toContain('[sandbox error] eval: 503');
    expect(toolOutputContent(out)).toContain('boom');
    expect(readToolErrorCode(out)).toBe('provider_error');
  });

  it('rate-limit status (429) → rate_limited error code', async () => {
    const exec = new SandboxExecutor({
      binding: fakeFetcher(async () => new Response('slow down', { status: 429 })),
      sandboxToolName: 'eval',
    });
    const out = await exec.execute({});
    expect(readToolErrorCode(out)).toBe('rate_limited');
  });

  it('exit_code != 0 → soft-error with provider_error code', async () => {
    const exec = new SandboxExecutor({
      binding: fakeFetcher(
        async () =>
          new Response(JSON.stringify({ exit_code: 1, stderr: 'SyntaxError', content: '' }), {
            status: 200,
          }),
      ),
      sandboxToolName: 'py',
    });
    const out = await exec.execute({});
    expect(toolOutputContent(out)).toBe('[sandbox exit 1] py: SyntaxError');
    expect(readToolErrorCode(out)).toBe('provider_error');
  });

  it('AbortSignal cancellation → soft-error with user_aborted code', async () => {
    const exec = new SandboxExecutor({
      binding: fakeFetcher(async (_req) => {
        // Wait until aborted, then throw the AbortError fetch produces
        // on cancellation.
        await new Promise<void>((_, reject) => {
          // Synchronously-aborted signal is what the test passes below.
          reject(new DOMException('aborted', 'AbortError'));
        });
        return new Response('unreachable', { status: 200 });
      }),
      sandboxToolName: 'py',
    });
    const controller = new AbortController();
    controller.abort(new DOMException('user cancelled', 'AbortError'));
    const out = await exec.execute({}, { signal: controller.signal });
    expect(toolOutputContent(out)).toContain('[sandbox cancelled] py:');
    expect(readToolErrorCode(out)).toBe('user_aborted');
  });

  it('honors path_prefix when constructing the fetch URL', async () => {
    const captured: string[] = [];
    const exec = new SandboxExecutor({
      binding: fakeFetcher(async (req) => {
        captured.push(req.url);
        return new Response(JSON.stringify({ content: 'ok' }), { status: 200 });
      }),
      sandboxToolName: 'py',
      pathPrefix: '/sbx',
    });
    await exec.execute({});
    expect(captured[0]).toMatch(/\/sbx\/exec$/);
  });

  it('treats a successful empty response body as a sentinel string', async () => {
    const exec = new SandboxExecutor({
      binding: fakeFetcher(async () => new Response('{}', { status: 200 })),
      sandboxToolName: 'py',
    });
    const out = await exec.execute({});
    expect(out).toBe('[sandbox returned no content]');
  });
});

describe('makeSandboxTool', () => {
  it("fails the build when the named binding isn't on env", () => {
    expect(() => makeSandboxTool({ name: 'py', binding: 'SANDBOX_MISSING' }, {})).toThrow(
      /binding 'SANDBOX_MISSING' which is not configured/,
    );
  });

  it('builds a Tool with transport=sandbox when the binding is present', () => {
    const fetcher = fakeFetcher(async () => new Response('{}', { status: 200 }));
    const tool = makeSandboxTool({ name: 'py', binding: 'SANDBOX' }, { SANDBOX: fetcher });
    expect(tool.name).toBe('py');
    expect(tool.executor.transport).toBe('sandbox');
    expect(tool.source).toBe('sandbox:py');
  });

  it('uses sandbox_tool_name when set, otherwise falls back to name', () => {
    const fetcher = fakeFetcher(async () => new Response('{}', { status: 200 }));
    const tool = makeSandboxTool(
      { name: 'py', binding: 'SANDBOX', sandbox_tool_name: 'python3' },
      { SANDBOX: fetcher },
    );
    expect(tool.source).toBe('sandbox:python3');
  });
});
