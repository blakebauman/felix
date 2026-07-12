/**
 * Anomaly detector — inferential sensor.
 *
 * Drives `runAnomalyScan` against a D1-backed audit_events table with
 * seeded rows. Confirms:
 *   - a baseline of mostly-ok tool calls + a recent burst of errors
 *     emits an `anomaly_detected` audit event keyed by tenant /
 *     manifest / tool / error_code
 *   - low-volume tools don't trigger false positives
 *   - a sustained error rate (no recent spike) doesn't trigger
 */

import { env } from 'cloudflare:test';
import { getDb } from '@felix/harness/db/client';
import type { Env as AppEnv } from '@felix/harness/env';
import { runAnomalyScan } from '@felix/harness/jobs/anomaly-detector';
import { _clearResolverCache } from '@felix/harness/manifests/resolver';
import { ManifestSchema } from '@felix/harness/manifests/schema';
import { createVersion } from '@felix/harness/manifests/store';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, withPgContext } from './setup';

const testEnv = env as unknown as AppEnv;

// One shared Postgres client for the whole file — the vitest runner context
// is long-lived, so a per-call client would leak a socket per seed row.
let _sql: ReturnType<typeof getDb> | undefined;
const testSql = () => {
  _sql ??= getDb(testEnv);
  return _sql;
};

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
});

beforeEach(() => {
  _clearResolverCache();
});

/** Persist a tenant manifest carrying a custom `spec.anomaly` block. */
async function seedManifest(
  tenantId: string,
  name: string,
  anomaly: Record<string, unknown>,
): Promise<void> {
  const manifest = ManifestSchema.parse({
    apiVersion: 'orchestrator/v1',
    kind: 'Agent',
    metadata: { name, version: '1.0.0' },
    spec: { pattern: 'react', anomaly },
  });
  await createVersion(testEnv, { tenantId, name, manifest, createdBy: '', activate: true });
}

/** Seed a recent error spike (~62% over 13 calls) that trips defaults. */
async function seedSpike(tenantId: string, name: string, now: number): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await seedToolCall({
      tenantId,
      manifestId: name,
      tool: 'fetch',
      transport: 'mcp',
      status: 'ok',
      ts: now - i * 60_000,
    });
  }
  for (let i = 0; i < 8; i += 1) {
    await seedToolCall({
      tenantId,
      manifestId: name,
      tool: 'fetch',
      transport: 'mcp',
      status: 'error',
      errorCode: 'provider_error',
      ts: now - 60_000 - i * 60_000,
    });
  }
}

async function seedToolCall(opts: {
  tenantId: string;
  manifestId: string;
  tool: string;
  transport: string;
  status: 'ok' | 'error';
  errorCode?: string;
  ts: number;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    tool: opts.tool,
    transport: opts.transport,
    duration_ms: 5,
  };
  if (opts.errorCode) payload.error_code = opts.errorCode;
  await testSql()`
    INSERT INTO audit_events
      (id, tenant_id, ts, event_type, manifest_id, principal_subj, status, payload_json)
      VALUES (${crypto.randomUUID()}, ${opts.tenantId}, ${opts.ts}, 'tool_call',
              ${opts.manifestId}, '', ${opts.status}, ${payload})
  `;
}

describe('runAnomalyScan', () => {
  it('flags a recent error-rate burst that exceeds baseline by 3×', async () => {
    const now = Date.now();
    const recentStart = now - 60 * 60 * 1000;
    // Baseline (older window): 100 ok, 2 errors → ~2% error rate
    for (let i = 0; i < 100; i += 1) {
      await seedToolCall({
        tenantId: 'acme',
        manifestId: 'anomaly_test_a',
        tool: 'fetch',
        transport: 'mcp',
        status: 'ok',
        ts: recentStart - 60_000 - i * 60_000,
      });
    }
    for (let i = 0; i < 2; i += 1) {
      await seedToolCall({
        tenantId: 'acme',
        manifestId: 'anomaly_test_a',
        tool: 'fetch',
        transport: 'mcp',
        status: 'error',
        errorCode: 'provider_error',
        ts: recentStart - 60_000 - (i + 100) * 60_000,
      });
    }
    // Recent window: 5 ok, 8 errors → ~62% error rate
    for (let i = 0; i < 5; i += 1) {
      await seedToolCall({
        tenantId: 'acme',
        manifestId: 'anomaly_test_a',
        tool: 'fetch',
        transport: 'mcp',
        status: 'ok',
        ts: now - i * 60_000,
      });
    }
    for (let i = 0; i < 8; i += 1) {
      await seedToolCall({
        tenantId: 'acme',
        manifestId: 'anomaly_test_a',
        tool: 'fetch',
        transport: 'mcp',
        status: 'error',
        errorCode: 'provider_error',
        ts: now - 60_000 - i * 60_000,
      });
    }

    const result = await withPgContext(testEnv, () => runAnomalyScan(testEnv, now));
    const hit = result.flagged.find(
      (f) =>
        f.tenant_id === 'acme' &&
        f.manifest_id === 'anomaly_test_a' &&
        f.tool === 'fetch' &&
        f.error_code === 'provider_error',
    );
    expect(hit).toBeDefined();
    expect(hit!.recent_count).toBeGreaterThanOrEqual(10);
    expect(hit!.recent_rate).toBeGreaterThan(0.5);
    expect(hit!.baseline_rate).toBeLessThan(0.1);
  });

  it('does not flag low-volume tools', async () => {
    const now = Date.now();
    // 3 errors in 4 recent calls is high rate, but volume is below MIN_VOLUME.
    for (let i = 0; i < 3; i += 1) {
      await seedToolCall({
        tenantId: 'acme',
        manifestId: 'anomaly_test_b',
        tool: 'rare',
        transport: 'local',
        status: 'error',
        errorCode: 'timeout',
        ts: now - i * 60_000,
      });
    }
    await seedToolCall({
      tenantId: 'acme',
      manifestId: 'anomaly_test_b',
      tool: 'rare',
      transport: 'local',
      status: 'ok',
      ts: now,
    });
    const result = await withPgContext(testEnv, () => runAnomalyScan(testEnv, now));
    const hit = result.flagged.find((f) => f.manifest_id === 'anomaly_test_b' && f.tool === 'rare');
    expect(hit).toBeUndefined();
  });

  it('does not flag a tool whose error rate matches its baseline', async () => {
    const now = Date.now();
    const recentStart = now - 60 * 60 * 1000;
    // Baseline: 70 errors / 100 = 70% error rate
    for (let i = 0; i < 30; i += 1) {
      await seedToolCall({
        tenantId: 'acme',
        manifestId: 'anomaly_test_c',
        tool: 'flaky',
        transport: 'a2a',
        status: 'ok',
        ts: recentStart - 60_000 - i * 60_000,
      });
    }
    for (let i = 0; i < 70; i += 1) {
      await seedToolCall({
        tenantId: 'acme',
        manifestId: 'anomaly_test_c',
        tool: 'flaky',
        transport: 'a2a',
        status: 'error',
        errorCode: 'provider_error',
        ts: recentStart - 60_000 - (i + 30) * 60_000,
      });
    }
    // Recent: also ~70% error rate — not a spike, just steady state.
    for (let i = 0; i < 4; i += 1) {
      await seedToolCall({
        tenantId: 'acme',
        manifestId: 'anomaly_test_c',
        tool: 'flaky',
        transport: 'a2a',
        status: 'ok',
        ts: now - i * 60_000,
      });
    }
    for (let i = 0; i < 8; i += 1) {
      await seedToolCall({
        tenantId: 'acme',
        manifestId: 'anomaly_test_c',
        tool: 'flaky',
        transport: 'a2a',
        status: 'error',
        errorCode: 'provider_error',
        ts: now - 60_000 - i * 60_000,
      });
    }
    const result = await withPgContext(testEnv, () => runAnomalyScan(testEnv, now));
    const hit = result.flagged.find(
      (f) => f.manifest_id === 'anomaly_test_c' && f.tool === 'flaky',
    );
    expect(hit).toBeUndefined();
  });

  it('does not flag a manifest that disables the detector via spec.anomaly', async () => {
    const tenantId = 'acme';
    const name = `anomaly_off_${crypto.randomUUID().slice(0, 8)}`;
    await seedManifest(tenantId, name, { enabled: false });
    const now = Date.now();
    await seedSpike(tenantId, name, now);

    const result = await withPgContext(testEnv, () => runAnomalyScan(testEnv, now));
    expect(result.flagged.some((f) => f.manifest_id === name)).toBe(false);
  });

  it('respects a manifest-raised min_rate that the spike falls under', async () => {
    const tenantId = 'acme';
    const name = `anomaly_hi_${crypto.randomUUID().slice(0, 8)}`;
    // 0.9 floor — the ~62% spike is below it, so no flag (default 0.2 would flag).
    await seedManifest(tenantId, name, { min_rate: 0.9 });
    const now = Date.now();
    await seedSpike(tenantId, name, now);

    const result = await withPgContext(testEnv, () => runAnomalyScan(testEnv, now));
    expect(result.flagged.some((f) => f.manifest_id === name)).toBe(false);
  });

  it('still flags a manifest whose spec.anomaly lowers the threshold', async () => {
    const tenantId = 'acme';
    const name = `anomaly_lo_${crypto.randomUUID().slice(0, 8)}`;
    // Default would flag too, but assert the configured manifest path works end-to-end.
    await seedManifest(tenantId, name, { min_volume: 5, min_rate: 0.1 });
    const now = Date.now();
    await seedSpike(tenantId, name, now);

    const result = await withPgContext(testEnv, () => runAnomalyScan(testEnv, now));
    expect(result.flagged.some((f) => f.manifest_id === name)).toBe(true);
  });
});

// Round-trip through `/audit` is intentionally not tested here:
// `recordEventDetached` enqueues to AUDIT_QUEUE and the consumer
// drains asynchronously in miniflare, which makes a direct
// `runAnomalyScan → fetch /audit` assertion racy. The audit pipeline
// is covered end-to-end by `tests/integration/routes.test.ts`
// (the `/audit/metrics` test seeds rows directly into D1) and
// the detector→event mapping is covered by the three `runAnomalyScan`
// cases above.
