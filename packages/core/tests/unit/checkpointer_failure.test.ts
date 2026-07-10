/**
 * persistFireAndForget routes terminal session-append failures to audit +
 * a counter instead of silently swallowing them in console.warn. We can't
 * easily test the retry inside DoSession without a live DO; instead, pin
 * the user-facing contract: if appendBatch rejects, the helper records a
 * `checkpoint_failure` audit event under the request scope.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auditStore from '../../src/audit/store';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { persistFireAndForget } from '../../src/session/do-session';
import type { Session } from '../../src/session/types';

function ctx(): RequestContext {
  return { env: {} as Env, auth: ANONYMOUS, limitState: newLimitState() };
}

const failingSession: Session = {
  id: 't1',
  async getEvents() {
    return [];
  },
  async head() {
    return { seq: 0 };
  },
  async append() {
    throw new Error('do unavailable');
  },
  async appendBatch() {
    throw new Error('do unavailable');
  },
  async reset() {},
  async wake() {
    return { fresh: true, headSeq: 0, pendingToolCalls: [], endedOnAssistant: false };
  },
};

const sessionWithoutId: Session = { ...failingSession, id: '' };

describe('persistFireAndForget failure path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a checkpoint_failure audit event on terminal failure', async () => {
    const recorded: Array<{ eventType: string; status: string }> = [];
    vi.spyOn(auditStore, 'recordEvent').mockImplementation((opts) => {
      recorded.push({ eventType: opts.eventType, status: opts.status ?? '' });
      return {
        id: '',
        tenant_id: opts.tenantId,
        ts: 0,
        event_type: opts.eventType,
        manifest_id: opts.manifestId ?? '',
        principal_subject: opts.principalSubject ?? '',
        status: opts.status ?? '',
        payload: opts.payload ?? {},
      };
    });
    let pending: Promise<unknown> | undefined;
    const c: RequestContext = {
      ...ctx(),
      execCtx: {
        waitUntil: (p: Promise<unknown>) => {
          pending = p;
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    };
    await runWithContext(c, async () => {
      persistFireAndForget(failingSession, [{ kind: 'message', role: 'user', content: 'hi' }], {
        manifestId: 'm',
      });
    });
    await pending; // wait for the fire-and-forget promise to settle
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.eventType).toBe('checkpoint_failure');
    expect(recorded[0]!.status).toBe('failed');
  });

  it('is a no-op when session has no id', async () => {
    const recordSpy = vi.spyOn(auditStore, 'recordEvent');
    await runWithContext(ctx(), async () => {
      persistFireAndForget(sessionWithoutId, [{ kind: 'message', role: 'user', content: 'hi' }], {
        manifestId: 'm',
      });
    });
    // No write was attempted, so no failure event either.
    expect(recordSpy).not.toHaveBeenCalled();
  });
});
