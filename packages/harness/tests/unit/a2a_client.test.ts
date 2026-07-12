import { afterEach, describe, expect, it, vi } from 'vitest';
import { makePeerTool } from '../../src/a2a/client';
import type { Env } from '../../src/env';
import type { A2APeerRef } from '../../src/manifests/schema';
import { readToolErrorCode } from '../../src/tools/errors';

function ref(name: string): A2APeerRef {
  return { name, url: 'https://peer.example.com', auth: '' };
}

function fakeEnv(): Env {
  return { ENVIRONMENT: 'production' } as Env;
}

// Fetch mock that never resolves until its signal aborts, then rejects with
// the signal reason — mirroring the platform's behavior on an aborted fetch.
function hangUntilAbortFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener('abort', () =>
          reject(signal.reason ?? new DOMException('aborted', 'AbortError')),
        );
      }),
  );
}

describe('makePeerTool — per-call timeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('aborts a hung peer call at the default timeout and surfaces a `timeout` error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangUntilAbortFetch());
    const tool = makePeerTool(ref('billing'), fakeEnv());

    const p = tool.executor.execute({ message: 'hello' });
    // The 30s default per-call timeout fires and cancels the in-flight fetch.
    await vi.advanceTimersByTimeAsync(30_000);
    const out = await p;
    expect(readToolErrorCode(out)).toBe('timeout');
  });

  it('maps a caller-driven abort to `user_aborted`, not `timeout`', async () => {
    vi.stubGlobal('fetch', hangUntilAbortFetch());
    const tool = makePeerTool(ref('billing'), fakeEnv());

    const controller = new AbortController();
    const p = tool.executor.execute({ message: 'hello' }, { signal: controller.signal });
    controller.abort(new DOMException('request torn down', 'AbortError'));
    const out = await p;
    expect(readToolErrorCode(out)).toBe('user_aborted');
  });
});
