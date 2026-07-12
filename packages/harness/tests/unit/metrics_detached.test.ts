import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import { recordCounter, recordCounterDetached } from '../../src/observability/metrics';

/**
 * Pins the detached-counter contract: call sites that run before
 * `runWithContext` (e.g. authMiddleware's misconfiguration check) must reach
 * the Analytics Engine binding via the provided Env — the context-reading
 * `recordCounter` silently falls back to console.log there because
 * `getContext()` is undefined.
 */
describe('recordCounterDetached', () => {
  function fakeEnv() {
    const writeDataPoint = vi.fn();
    return {
      env: { METRICS: { writeDataPoint } } as unknown as Env,
      writeDataPoint,
    };
  }

  it('writes to env.METRICS with no RequestContext installed', () => {
    const { env, writeDataPoint } = fakeEnv();
    recordCounterDetached(env, 'orchestrator_auth_misconfigured', { environment: 'production' });
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const point = writeDataPoint.mock.calls[0]![0] as { blobs: string[]; doubles: number[] };
    expect(point.blobs).toContain('orchestrator_auth_misconfigured');
    expect(point.blobs).toContain('environment=production');
    expect(point.doubles).toEqual([1]);
  });

  it('context-reading recordCounter misses the binding without a context (shadow path)', () => {
    const { writeDataPoint } = fakeEnv();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      recordCounter('orchestrator_auth_misconfigured', { environment: 'production' });
      expect(writeDataPoint).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('degrades to the console.log shadow path when METRICS is absent', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      recordCounterDetached({} as Env, 'orchestrator_auth_misconfigured', {});
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});
