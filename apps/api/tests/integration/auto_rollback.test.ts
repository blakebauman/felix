/**
 * Auto-rollback on anomaly.
 *
 * When the Phase-5 anomaly cron flags a manifest that has an active
 * canary, the detector zeroes `canary_weight` and emits an
 * `auto_rollback` audit event. Pins:
 *
 *   - A manifest with a canary that's flagged by the anomaly cron
 *     ends up with `canary_weight = 0` and an `auto_rollback`
 *     audit row.
 *   - A manifest with NO canary is untouched (only the
 *     `anomaly_detected` event lands; no `auto_rollback`).
 *   - A second cron tick on the same manifest doesn't double-roll
 *     (canary is already 0).
 */

import { env } from 'cloudflare:test';
import { getDb } from '@felix/harness/db/client';
import type { Env as AppEnv } from '@felix/harness/env';
import { runAnomalyScan } from '@felix/harness/jobs/anomaly-detector';
import { _clearResolverCache } from '@felix/harness/manifests/resolver';
import { ManifestSchema } from '@felix/harness/manifests/schema';
import { clearCanary, createVersion, getActive, setCanary } from '@felix/harness/manifests/store';
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

const sampleManifest = ManifestSchema.parse({
  apiVersion: 'orchestrator/v1',
  kind: 'Agent',
  metadata: { name: 'rollback_test', version: '1.0.0' },
  spec: {},
});

async function seedToolCall(opts: {
  tenantId: string;
  manifestId: string;
  tool: string;
  status: 'ok' | 'error';
  errorCode?: string;
  variant?: 'stable' | 'canary';
  ts: number;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    tool: opts.tool,
    transport: 'mcp',
    duration_ms: 5,
  };
  if (opts.errorCode) payload.error_code = opts.errorCode;
  if (opts.variant) payload.manifest_variant = opts.variant;
  await testSql()`
    INSERT INTO audit_events
      (id, tenant_id, ts, event_type, manifest_id, principal_subj, status, payload_json)
      VALUES (${crypto.randomUUID()}, ${opts.tenantId}, ${opts.ts}, 'tool_call',
              ${opts.manifestId}, '', ${opts.status}, ${payload})
  `;
}

async function seedManifestWithCanary(
  tenantId: string,
  name: string,
): Promise<{ stable: number; canary: number }> {
  const v1 = await createVersion(testEnv, {
    tenantId,
    name,
    manifest: { ...sampleManifest, metadata: { ...sampleManifest.metadata, name } },
    createdBy: '',
    activate: true,
  });
  const v2 = await createVersion(testEnv, {
    tenantId,
    name,
    manifest: { ...sampleManifest, metadata: { ...sampleManifest.metadata, name } },
    createdBy: '',
    activate: false,
  });
  await setCanary(testEnv, {
    tenantId,
    name,
    canaryVersion: v2.version,
    canaryWeight: 50,
    updatedBy: '',
  });
  return { stable: v1.version, canary: v2.version };
}

describe('auto-rollback on anomaly', () => {
  it('zeroes canary weight when the canary variant itself spikes', async () => {
    const tenantId = 'acme';
    const name = `auto_rb_${crypto.randomUUID().slice(0, 8)}`;
    const { canary } = await seedManifestWithCanary(tenantId, name);

    // Seed enough recent errors *on the canary variant* to trip the threshold.
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await seedToolCall({
        tenantId,
        manifestId: name,
        tool: 'fetch',
        status: 'ok',
        variant: 'canary',
        ts: now - i * 60_000,
      });
    }
    for (let i = 0; i < 8; i += 1) {
      await seedToolCall({
        tenantId,
        manifestId: name,
        tool: 'fetch',
        status: 'error',
        errorCode: 'provider_error',
        variant: 'canary',
        ts: now - 60_000 - i * 60_000,
      });
    }

    const before = await getActive(testEnv, tenantId, name);
    expect(before?.canary_weight).toBe(50);
    expect(before?.canary_version).toBe(canary);

    await withPgContext(testEnv, () => runAnomalyScan(testEnv, now));

    const after = await getActive(testEnv, tenantId, name);
    expect(after?.canary_weight).toBe(0);
    // We default to keeping the version pinned (clearVersion: false) so a
    // follow-up `POST /manifests/:name/canary` can re-flip without
    // re-supplying the version.
    expect(after?.canary_version).toBe(canary);
  });

  it('does NOT roll back the canary when the STABLE variant is the one spiking', async () => {
    const tenantId = 'acme';
    const name = `stable_spike_${crypto.randomUUID().slice(0, 8)}`;
    const { canary } = await seedManifestWithCanary(tenantId, name);

    // Errors are all on the stable variant; the canary is healthy. Previously
    // this tripped a false-positive rollback of the (innocent) canary.
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await seedToolCall({
        tenantId,
        manifestId: name,
        tool: 'fetch',
        status: 'ok',
        variant: 'stable',
        ts: now - i * 60_000,
      });
    }
    for (let i = 0; i < 8; i += 1) {
      await seedToolCall({
        tenantId,
        manifestId: name,
        tool: 'fetch',
        status: 'error',
        errorCode: 'provider_error',
        variant: 'stable',
        ts: now - 60_000 - i * 60_000,
      });
    }

    const result = await withPgContext(testEnv, () => runAnomalyScan(testEnv, now));
    // The stable spike is still surfaced as an alert...
    const hit = result.flagged.find((f) => f.manifest_id === name && f.variant === 'stable');
    expect(hit).toBeDefined();
    // ...but the canary is left untouched.
    const after = await getActive(testEnv, tenantId, name);
    expect(after?.canary_weight).toBe(50);
    expect(after?.canary_version).toBe(canary);
  });

  it('does NOT roll back when the flagged manifest has no canary', async () => {
    const tenantId = 'acme';
    const name = `no_canary_${crypto.randomUUID().slice(0, 8)}`;
    await createVersion(testEnv, {
      tenantId,
      name,
      manifest: { ...sampleManifest, metadata: { ...sampleManifest.metadata, name } },
      createdBy: '',
      activate: true,
    });
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await seedToolCall({
        tenantId,
        manifestId: name,
        tool: 'fetch',
        status: 'ok',
        ts: now - i * 60_000,
      });
    }
    for (let i = 0; i < 8; i += 1) {
      await seedToolCall({
        tenantId,
        manifestId: name,
        tool: 'fetch',
        status: 'error',
        errorCode: 'provider_error',
        ts: now - 60_000 - i * 60_000,
      });
    }

    const result = await withPgContext(testEnv, () => runAnomalyScan(testEnv, now));
    expect(result.flagged.some((f) => f.manifest_id === name)).toBe(true);

    const after = await getActive(testEnv, tenantId, name);
    expect(after?.canary_weight).toBe(0);
    expect(after?.canary_version).toBeNull();
  });

  it('does not double-roll when the canary is already cleared', async () => {
    const tenantId = 'acme';
    const name = `double_rb_${crypto.randomUUID().slice(0, 8)}`;
    await seedManifestWithCanary(tenantId, name);
    // Clear canary manually first.
    await clearCanary(testEnv, { tenantId, name, clearVersion: false, updatedBy: '' });
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await seedToolCall({
        tenantId,
        manifestId: name,
        tool: 'fetch',
        status: 'ok',
        ts: now - i * 60_000,
      });
    }
    for (let i = 0; i < 8; i += 1) {
      await seedToolCall({
        tenantId,
        manifestId: name,
        tool: 'fetch',
        status: 'error',
        errorCode: 'provider_error',
        ts: now - 60_000 - i * 60_000,
      });
    }
    // Should not throw; the auto-rollback path skips cleanly when there's
    // no active canary.
    await expect(withPgContext(testEnv, () => runAnomalyScan(testEnv, now))).resolves.toBeDefined();
    const after = await getActive(testEnv, tenantId, name);
    expect(after?.canary_weight).toBe(0);
  });
});
