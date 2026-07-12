/**
 * ConversationDO idle-TTL alarm.
 *
 * Pins the day-2 GC contract for threads: every append sets/renews a DO alarm,
 * and when the alarm fires it wipes the thread's storage iff it has been idle
 * for at least `CONVERSATION_IDLE_TTL_DAYS` — otherwise it reschedules to the
 * real expiry. Storage/state are stubbed in-memory so the test stays decoupled
 * from workerd.
 */

import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { ConversationDO, parseConversationIdleTtlDays } from '../../src/memory/conversation-do';

const DAY_MS = 24 * 60 * 60 * 1000;

/** In-memory DurableObjectState covering the storage surface the DO touches. */
function fakeState() {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  const state = {
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return store.get(key) as T | undefined;
      },
      async put(key: string, value: unknown): Promise<void> {
        store.set(key, value);
      },
      async delete(key: string): Promise<void> {
        store.delete(key);
      },
      async deleteAll(): Promise<void> {
        store.clear();
      },
      async setAlarm(ts: number): Promise<void> {
        alarm = ts;
      },
    },
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
  return {
    state: state as unknown as DurableObjectState,
    store,
    getAlarm: () => alarm,
  };
}

function makeDO(env: Partial<Env> = {}) {
  const f = fakeState();
  const doInstance = new ConversationDO(f.state, env as Env);
  return { doInstance, ...f };
}

async function append(doInstance: ConversationDO, content: string) {
  return doInstance.fetch(
    new Request('https://do/events', {
      method: 'POST',
      body: JSON.stringify({ events: [{ kind: 'message', role: 'user', content }] }),
    }),
  );
}

describe('ConversationDO idle-TTL', () => {
  it('sets an alarm on append', async () => {
    const { doInstance, getAlarm } = makeDO();
    const before = Date.now();
    await append(doInstance, 'hi');
    const alarm = getAlarm();
    expect(alarm).not.toBeNull();
    // Default 90-day TTL from `now`.
    expect(alarm!).toBeGreaterThanOrEqual(before + 90 * DAY_MS);
  });

  it('deletes an idle thread when the alarm fires', async () => {
    const { doInstance, store } = makeDO();
    await append(doInstance, 'hi');
    expect(store.get('state')).toBeDefined();
    // Age the thread past the TTL.
    const stored = store.get('state') as { updatedAt: number };
    stored.updatedAt = Date.now() - 200 * DAY_MS;
    await doInstance.alarm();
    // Storage wiped.
    expect(store.get('state')).toBeUndefined();
  });

  it('reschedules (does not delete) a recently-active thread', async () => {
    const { doInstance, store, getAlarm } = makeDO();
    await append(doInstance, 'hi');
    const stored = store.get('state') as { updatedAt: number };
    stored.updatedAt = Date.now() - 1 * DAY_MS; // touched yesterday, well within 90d
    await doInstance.alarm();
    // Survives, and the alarm was rescheduled to updatedAt + TTL.
    expect(store.get('state')).toBeDefined();
    expect(getAlarm()).toBe(stored.updatedAt + 90 * DAY_MS);
  });

  it('alarm on an already-empty thread is a no-op', async () => {
    const { doInstance, store } = makeDO();
    await expect(doInstance.alarm()).resolves.toBeUndefined();
    expect(store.get('state')).toBeUndefined();
  });

  it('parseConversationIdleTtlDays — default, override, clamp, bad input', () => {
    const env = (v?: string) => ({ CONVERSATION_IDLE_TTL_DAYS: v }) as unknown as Env;
    expect(parseConversationIdleTtlDays(env())).toBe(90);
    expect(parseConversationIdleTtlDays(env('nope'))).toBe(90);
    expect(parseConversationIdleTtlDays(env('30'))).toBe(30);
    // Clamp: below floor (1) and above ceiling (3650).
    expect(parseConversationIdleTtlDays(env('0'))).toBe(1);
    expect(parseConversationIdleTtlDays(env('999999'))).toBe(3650);
  });
});
