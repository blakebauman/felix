/**
 * ContainerExecutor — brain-hands transport for sandboxed work.
 *
 * Pins:
 *   1. Happy path: POSTs the right body, returns `content`.
 *   2. transport label is `'container'` on the underlying executor.
 *   3. Non-2xx → recoverable string the model can see (no throw).
 *   4. Non-zero exit_code → `[container exit N] ...` string.
 *   5. AbortSignal cancellation → `[container cancelled] ...` string.
 *   6. Auth header from authProvider attaches to the request.
 *   7. SSRF guard rejects private hosts at fetch time (no real request).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Env } from '../../../src/env';
import { ContainerExecutor, containerTool } from '../../../src/tools/container-executor';
import { readToolErrorCode, toolOutputContent } from '../../../src/tools/errors';

function fakeEnv(): Env {
  // ENVIRONMENT=production blocks the dev-mode http://localhost exception
  // so we get the production-safety SSRF behavior under test.
  return { ENVIRONMENT: 'production' } as unknown as Env;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('ContainerExecutor', () => {
  beforeEach(() => {
    // Default: success response. Individual tests override as needed.
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ content: 'ok' }), { status: 200 }),
    ) as never;
  });

  it('posts {image, tool, arguments} and returns content on success', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ content: 'hello from sandbox' }), { status: 200 });
    }) as never;
    const exec = new ContainerExecutor({
      gatewayUrl: 'https://container.example.com/run',
      image: 'py-sandbox:1',
      containerToolName: 'eval_expr',
      env: fakeEnv(),
    });
    expect(exec.transport).toBe('container');
    const out = await exec.execute({ expr: '2+2' });
    expect(out).toBe('hello from sandbox');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://container.example.com/run');
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({
      image: 'py-sandbox:1',
      tool: 'eval_expr',
      arguments: { expr: '2+2' },
    });
  });

  it('returns a recoverable string on a non-2xx response (no throw)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 503 })) as never;
    const exec = new ContainerExecutor({
      gatewayUrl: 'https://container.example.com/run',
      image: 'py:1',
      containerToolName: 'go',
      env: fakeEnv(),
    });
    const out = await exec.execute({});
    expect(toolOutputContent(out)).toContain('[container error] py:1: 503');
    expect(toolOutputContent(out)).toContain('boom');
    expect(readToolErrorCode(out)).toBe('provider_error');
  });

  it('formats non-zero exit codes as a recoverable string', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ exit_code: 137, stderr: 'OOMKilled', content: '' }), {
          status: 200,
        }),
    ) as never;
    const exec = new ContainerExecutor({
      gatewayUrl: 'https://container.example.com/run',
      image: 'py:1',
      containerToolName: 'go',
      env: fakeEnv(),
    });
    const out = await exec.execute({});
    expect(toolOutputContent(out)).toBe('[container exit 137] go: OOMKilled');
    expect(readToolErrorCode(out)).toBe('provider_error');
  });

  it('attaches Authorization from authProvider', async () => {
    let seenAuth: string | undefined;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seenAuth = headers?.authorization;
      return new Response(JSON.stringify({ content: 'ok' }), { status: 200 });
    }) as never;
    const exec = new ContainerExecutor({
      gatewayUrl: 'https://container.example.com/run',
      image: 'py:1',
      containerToolName: 'go',
      env: fakeEnv(),
      authProvider: async () => 'Bearer abc123',
    });
    await exec.execute({});
    expect(seenAuth).toBe('Bearer abc123');
  });

  it('returns a cancelled string when ctx.signal fires before the response', async () => {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      // Wait until aborted, then throw an AbortError — the shape `fetch`
      // produces on cancellation.
      await new Promise<void>((resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
        // safety net
        setTimeout(resolve, 1000);
      });
      return new Response('should not reach', { status: 200 });
    }) as never;
    const exec = new ContainerExecutor({
      gatewayUrl: 'https://container.example.com/run',
      image: 'py:1',
      containerToolName: 'go',
      env: fakeEnv(),
    });
    const controller = new AbortController();
    const pending = exec.execute({}, { signal: controller.signal });
    controller.abort(new DOMException('user cancelled', 'AbortError'));
    const out = await pending;
    expect(toolOutputContent(out)).toContain('[container cancelled] go:');
    expect(readToolErrorCode(out)).toBe('user_aborted');
  });

  it('SSRF guard rejects a private host at the fetch site', async () => {
    const exec = new ContainerExecutor({
      gatewayUrl: 'https://192.168.1.1/run',
      image: 'py:1',
      containerToolName: 'go',
      env: fakeEnv(),
    });
    await expect(exec.execute({})).rejects.toThrow(/private\/loopback host not allowed/);
  });
});

describe('containerTool factory', () => {
  it('builds a Tool wrapping a ContainerExecutor with the right source label', () => {
    const tool = containerTool({
      name: 'sandbox_run',
      description: 'run code in a sandbox',
      args: z.object({ code: z.string() }),
      gatewayUrl: 'https://container.example.com/run',
      image: 'py-sandbox:1',
      env: fakeEnv(),
    });
    expect(tool.name).toBe('sandbox_run');
    expect(tool.source).toBe('container:py-sandbox:1');
    expect(tool.executor.transport).toBe('container');
  });

  it('defaults containerToolName to the outer tool name', async () => {
    let seenBody: { tool?: string } = {};
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ content: 'ok' }), { status: 200 });
    }) as never;
    const tool = containerTool({
      name: 'outer_name',
      description: '',
      args: z.object({}),
      gatewayUrl: 'https://container.example.com/run',
      image: 'img:1',
      env: fakeEnv(),
    });
    await tool.executor.execute({});
    expect(seenBody.tool).toBe('outer_name');
  });
});
