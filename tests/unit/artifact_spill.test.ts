/**
 * Artifact spill to R2. On success the model sees a compact stub; on an R2
 * put failure the full content is returned inline (no data loss) AND a
 * counter fires so the silently-degraded spill path is observable.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import * as metricsModule from '../../src/observability/metrics';
import { DEFAULT_ARTIFACTS_OPTS, spillArtifact } from '../../src/tools/artifacts';

afterEach(() => {
  vi.restoreAllMocks();
});

const ref = { tenantId: 'acme', threadId: 'thr-1', toolCallId: 'tc1' };
const big = 'x'.repeat(20_000);

function envWithBundles(put: (...args: unknown[]) => Promise<unknown>): Env {
  return { BUNDLES: { put } } as unknown as Env;
}

describe('spillArtifact', () => {
  it('writes to R2 and returns a stub on success', async () => {
    const put = vi.fn(async () => ({}));
    const out = await spillArtifact(envWithBundles(put), DEFAULT_ARTIFACTS_OPTS, ref, big);
    expect(put).toHaveBeenCalledOnce();
    expect(out).toContain('[artifact:tc1]');
    expect(out).toContain('20000 chars total');
    expect(out.length).toBeLessThan(big.length);
  });

  it('returns the full content inline AND emits a counter when the put fails', async () => {
    const counters: string[] = [];
    vi.spyOn(metricsModule, 'recordCounter').mockImplementation((name) => {
      counters.push(name);
    });
    const put = vi.fn(async () => {
      throw new Error('R2 unavailable');
    });
    const out = await spillArtifact(envWithBundles(put), DEFAULT_ARTIFACTS_OPTS, ref, big);
    // No data loss — the model still sees the content.
    expect(out).toBe(big);
    expect(counters).toContain('orchestrator_artifact_spill_failed');
  });
});
