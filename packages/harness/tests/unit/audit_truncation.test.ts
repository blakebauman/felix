/**
 * Per-request audit cap. Once 200 events are recorded a single
 * `audit_truncated` marker is emitted, then further events are dropped — but
 * the loss must stay observable: each drop increments a running count on the
 * request and emits an `orchestrator_audit_dropped` counter.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordEvent } from '../../src/audit/store';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import * as metricsModule from '../../src/observability/metrics';

afterEach(() => {
  vi.restoreAllMocks();
});

function ctx(): RequestContext {
  return { env: {} as Env, auth: ANONYMOUS, limitState: newLimitState() };
}

describe('audit truncation', () => {
  it('emits one marker then drops with an observable count + counter', async () => {
    const counters: string[] = [];
    vi.spyOn(metricsModule, 'recordCounter').mockImplementation((name) => {
      counters.push(name);
    });

    const results = await runWithContext(ctx(), async () => {
      const out: string[] = [];
      // 200 accepted + 1 marker + 5 dropped = 206 recordEvent calls.
      for (let i = 0; i < 206; i += 1) {
        out.push(recordEvent({ tenantId: 'default', eventType: 'tool_call' }).status ?? '');
      }
      return out;
    });

    const truncated = results.filter((s) => s === 'audit_truncated');
    const dropped = results.filter((s) => s === 'dropped_after_truncation');
    // Exactly one marker; everything after the cap+marker is a drop.
    expect(truncated).toHaveLength(1);
    expect(dropped.length).toBe(5);
    // One counter per dropped event.
    expect(counters.filter((n) => n === 'orchestrator_audit_dropped')).toHaveLength(5);
  });

  it('records the running dropped count in the drop marker payload', async () => {
    vi.spyOn(metricsModule, 'recordCounter').mockImplementation(() => {});
    const payloads = await runWithContext(ctx(), async () => {
      const out: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 203; i += 1) {
        out.push(recordEvent({ tenantId: 'default', eventType: 'tool_call' }).payload);
      }
      return out;
    });
    const dropMarkers = payloads.filter((p) => 'dropped_after_truncation' in p);
    expect(dropMarkers).toHaveLength(2);
    expect(dropMarkers[0]!.dropped_after_truncation).toBe(1);
    expect(dropMarkers[1]!.dropped_after_truncation).toBe(2);
  });
});
