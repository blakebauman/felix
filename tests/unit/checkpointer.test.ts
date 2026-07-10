/**
 * Unit tests for the DO-backed Session store. Stubs the `CONVERSATION_DO`
 * namespace with an in-memory map so we exercise the full
 * `appendBatch` / `getEvents` / `reset` round-trip without booting
 * miniflare.
 */

import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { getSessionStore } from '../../src/session/do-session';
import type { AppendableEvent, SessionEvent } from '../../src/session/types';

function fakeEnv(): { env: Env; stores: Map<string, SessionEvent[]> } {
  const stores = new Map<string, SessionEvent[]>();
  const nextSeq = new Map<string, number>();

  const stubFor = (threadId: string) => ({
    fetch: async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const method = init?.method ?? 'GET';
      if (u.pathname === '/events' && method === 'GET') {
        return new Response(
          JSON.stringify({
            events: stores.get(threadId) ?? [],
            head: nextSeq.get(threadId) ?? 0,
          }),
        );
      }
      if (u.pathname === '/events' && method === 'DELETE') {
        stores.delete(threadId);
        nextSeq.delete(threadId);
        return new Response('{}');
      }
      if (u.pathname === '/events' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { events: AppendableEvent[] };
        const cur = stores.get(threadId) ?? [];
        let seq = nextSeq.get(threadId) ?? 0;
        const now = Date.now();
        for (const ev of body.events) {
          cur.push({ ...ev, seq, ts: ev.ts ?? now } as SessionEvent);
          seq += 1;
        }
        stores.set(threadId, cur);
        nextSeq.set(threadId, seq);
        return new Response(JSON.stringify({ ok: true, head: seq }));
      }
      if (u.pathname === '/head' && method === 'GET') {
        return new Response(JSON.stringify({ seq: nextSeq.get(threadId) ?? 0 }));
      }
      return new Response('not found', { status: 404 });
    },
  });

  const env = {
    CONVERSATION_DO: {
      idFromName: (name: string) => name,
      get: (id: unknown) => stubFor(String(id)),
    },
  } as unknown as Env;

  return { env, stores };
}

describe('DoSession round-trip', () => {
  it('persists and replays a conversation', async () => {
    const { env, stores } = fakeEnv();
    const session = getSessionStore(env, 'do').open('t1');

    await session.appendBatch([
      { kind: 'message', role: 'user', content: 'hi' },
      { kind: 'message', role: 'assistant', content: 'hello' },
    ]);
    await session.append({
      kind: 'message',
      role: 'assistant',
      content: 'calling tool',
      tool_calls: [{ id: 'tc_1', name: 'calc', args: { x: 2 } }],
    });
    await session.append({
      kind: 'tool_result',
      role: 'tool',
      tool_call_id: 'tc_1',
      name: 'calc',
      content: '2',
    });

    expect(stores.get('t1')).toHaveLength(4);
    const events = await session.getEvents();
    expect(events.map((e) => e.role)).toEqual(['user', 'assistant', 'assistant', 'tool']);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(events[2]!.tool_calls).toEqual([{ id: 'tc_1', name: 'calc', args: { x: 2 } }]);
    expect(events[3]!.tool_call_id).toBe('tc_1');
  });

  it('reset wipes the thread', async () => {
    const { env, stores } = fakeEnv();
    const session = getSessionStore(env, 'do').open('t3');
    await session.append({ kind: 'message', role: 'user', content: 'hi' });
    expect(stores.get('t3')).toHaveLength(1);
    await session.reset();
    expect(stores.get('t3')).toBeUndefined();
  });

  it('noop store is returned for mode=none', async () => {
    const { env } = fakeEnv();
    const session = getSessionStore(env, 'none').open('t4');
    await session.append({ kind: 'message', role: 'user', content: 'ignored' });
    expect(await session.getEvents()).toEqual([]);
  });

  it('empty threadId returns a no-op session even on a DO store', async () => {
    const { env, stores } = fakeEnv();
    const session = getSessionStore(env, 'do').open('');
    await session.append({ kind: 'message', role: 'user', content: 'ignored' });
    expect(stores.size).toBe(0);
    expect(session.id).toBe('');
  });

  it('accepts legacy "agentcore" mode as a DO store', async () => {
    const { env, stores } = fakeEnv();
    const session = getSessionStore(env, 'agentcore').open('t5');
    await session.append({ kind: 'message', role: 'user', content: 'hi' });
    expect(stores.get('t5')).toHaveLength(1);
  });
});
