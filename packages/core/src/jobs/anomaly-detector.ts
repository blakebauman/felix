/**
 * Anomaly detection cron — flags tool-call failure spikes.
 *
 * Phase-5 framing (Cursor's "weekly anomaly review"): the Phase-1 error
 * taxonomy gives every failure a stable code, and the Phase-1 metrics
 * sink writes structured rows to D1. This job runs every cron tick,
 * compares the most recent error rate to a longer-window baseline per
 * `(tenant_id, manifest_id, variant, tool)`, and emits an
 * `anomaly_detected` audit event when the recent rate is sharply
 * elevated. An operator can then read `/audit?status=alert` to find
 * the affected manifest / variant / tool / code in one query. Grouping by
 * `variant` (`stable` / `canary`) lets the auto-rollback target only a
 * canary that is itself failing.
 *
 * Simpler than EWMA for v1: compare the last `RECENT_WINDOW_MS` error
 * rate against the prior `BASELINE_WINDOW_MS`. Fire when:
 *
 *   recent_count >= min_volume
 *   AND recent_error_rate >= min_rate
 *   AND recent_error_rate >= baseline_factor × baseline_error_rate
 *
 * The `min_volume` / `min_rate` / `baseline_factor` thresholds (and an
 * `enabled` kill-switch) come from each manifest's `spec.anomaly` block,
 * resolved per error-bearing manifest per tick; manifests without one (or
 * that no longer resolve) use `DEFAULT_ANOMALY_CONFIG`. The detection
 * *windows* stay global — per-manifest windows would need per-manifest
 * queries.
 */

import { recordEventDetached } from '../audit/store';
import type { Env } from '../env';
import { resolveManifest } from '../manifests/resolver';
import { type AnomalyConfig, DEFAULT_ANOMALY_CONFIG } from '../manifests/schema';
import { clearCanary, getActive } from '../manifests/store';
import { recordCounter } from '../observability/metrics';

const RECENT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const BASELINE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// Join tenant + manifest into a single Map key. NUL can't appear in a tenant
// id or manifest name, so it's a collision-free separator.
const SEP = '\u0000';

/**
 * Per-manifest detector thresholds (`spec.anomaly`). Resolved once per
 * error-bearing `(tenant, manifest)` per tick. A manifest that doesn't
 * resolve (e.g. deleted but still has audit rows) falls back to defaults.
 */
async function loadAnomalyConfig(env: Env, tenantId: string, name: string): Promise<AnomalyConfig> {
  try {
    const resolved = await resolveManifest(env, tenantId, name);
    return resolved.manifest.spec.anomaly ?? DEFAULT_ANOMALY_CONFIG;
  } catch {
    return DEFAULT_ANOMALY_CONFIG;
  }
}

interface RecentRow {
  tenant_id: string;
  manifest_id: string;
  variant: string;
  tool: string;
  errors: number;
  total: number;
}

interface ErrorCodeBreakdown {
  tenant_id: string;
  manifest_id: string;
  variant: string;
  tool: string;
  error_code: string | null;
  count: number;
}

/**
 * Query the most-recent window's tool-call activity, grouped by
 * `(tenant, manifest, variant, tool)`. Ok and error rows share a group so
 * the error rate is the proportion of failures over the total. The
 * `variant` (`stable` / `canary` / `''` for untagged legacy rows) keeps a
 * spike on one variant from being blamed on the other. The dominant
 * error_code is looked up separately by `loadErrorBreakdown`.
 */
async function loadRecent(env: Env, sinceMs: number): Promise<RecentRow[]> {
  const sql = `
    SELECT
      tenant_id,
      manifest_id,
      COALESCE(json_extract(payload_json, '$.manifest_variant'), '') AS variant,
      COALESCE(json_extract(payload_json, '$.tool'), '') AS tool,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
      COUNT(*) AS total
    FROM audit_events
    WHERE event_type = 'tool_call' AND ts >= ?
    GROUP BY tenant_id, manifest_id, variant, tool
  `;
  const rows = await env.DB.prepare(sql).bind(sinceMs).all<RecentRow>();
  return rows.results ?? [];
}

/**
 * Per-error-code error counts in the recent window. We attach the
 * dominant code to each flagged anomaly so the operator can see at a
 * glance what kind of failure is spiking (provider_error vs timeout
 * vs rate_limited).
 */
async function loadErrorBreakdown(
  env: Env,
  sinceMs: number,
): Promise<Map<string, Array<{ error_code: string | null; count: number }>>> {
  const sql = `
    SELECT
      tenant_id,
      manifest_id,
      COALESCE(json_extract(payload_json, '$.manifest_variant'), '') AS variant,
      COALESCE(json_extract(payload_json, '$.tool'), '') AS tool,
      json_extract(payload_json, '$.error_code') AS error_code,
      COUNT(*) AS count
    FROM audit_events
    WHERE event_type = 'tool_call' AND ts >= ? AND status = 'error'
    GROUP BY tenant_id, manifest_id, variant, tool, error_code
  `;
  const rows = await env.DB.prepare(sql).bind(sinceMs).all<ErrorCodeBreakdown>();
  const out = new Map<string, Array<{ error_code: string | null; count: number }>>();
  for (const row of rows.results ?? []) {
    const key = `${row.tenant_id}|${row.manifest_id}|${row.variant}|${row.tool}`;
    const list = out.get(key) ?? [];
    list.push({ error_code: row.error_code, count: row.count });
    out.set(key, list);
  }
  return out;
}

/**
 * Compute the baseline error rate per `(tenant, manifest, tool)`
 * over `BASELINE_WINDOW_MS`, excluding the recent window so the
 * comparison isn't comparing recent-against-itself.
 */
async function loadBaseline(
  env: Env,
  baselineStartMs: number,
  recentStartMs: number,
): Promise<Map<string, { errors: number; total: number }>> {
  const sql = `
    SELECT
      tenant_id,
      manifest_id,
      COALESCE(json_extract(payload_json, '$.manifest_variant'), '') AS variant,
      COALESCE(json_extract(payload_json, '$.tool'), '') AS tool,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
      COUNT(*) AS total
    FROM audit_events
    WHERE event_type = 'tool_call' AND ts >= ? AND ts < ?
    GROUP BY tenant_id, manifest_id, variant, tool
  `;
  const rows = await env.DB.prepare(sql).bind(baselineStartMs, recentStartMs).all<{
    tenant_id: string;
    manifest_id: string;
    variant: string;
    tool: string;
    errors: number;
    total: number;
  }>();
  const out = new Map<string, { errors: number; total: number }>();
  for (const row of rows.results ?? []) {
    out.set(`${row.tenant_id}|${row.manifest_id}|${row.variant}|${row.tool}`, {
      errors: row.errors,
      total: row.total,
    });
  }
  return out;
}

export interface AnomalyResult {
  flagged: Array<{
    tenant_id: string;
    manifest_id: string;
    variant: string;
    tool: string;
    error_code: string | null;
    recent_rate: number;
    baseline_rate: number;
    recent_count: number;
  }>;
}

/**
 * Run one pass of the detector and emit `anomaly_detected` audit
 * events for every flagged dimension. Exported for tests; production
 * callers reach this from the scheduled handler in `src/index.ts`.
 */
export async function runAnomalyScan(env: Env, now: number = Date.now()): Promise<AnomalyResult> {
  const recentStart = now - RECENT_WINDOW_MS;
  const baselineStart = now - BASELINE_WINDOW_MS;
  const [recent, baseline, breakdown] = await Promise.all([
    loadRecent(env, recentStart),
    loadBaseline(env, baselineStart, recentStart),
    loadErrorBreakdown(env, recentStart),
  ]);

  // Resolve each error-bearing manifest's `spec.anomaly` once per tick.
  // Healthy manifests (no errors) can never be flagged, so skip the lookup.
  const configs = new Map<string, AnomalyConfig>();
  const toLoad = new Map<string, { tenantId: string; name: string }>();
  for (const row of recent) {
    if (row.errors === 0) continue;
    const key = `${row.tenant_id}${SEP}${row.manifest_id}`;
    if (!toLoad.has(key)) toLoad.set(key, { tenantId: row.tenant_id, name: row.manifest_id });
  }
  await Promise.all(
    [...toLoad].map(async ([key, { tenantId, name }]) => {
      configs.set(key, await loadAnomalyConfig(env, tenantId, name));
    }),
  );

  const flagged: AnomalyResult['flagged'] = [];
  for (const row of recent) {
    if (row.errors === 0) continue;
    const cfg = configs.get(`${row.tenant_id}${SEP}${row.manifest_id}`) ?? DEFAULT_ANOMALY_CONFIG;
    if (!cfg.enabled) continue;
    if (row.total < cfg.min_volume) continue;
    const recentRate = row.errors / row.total;
    if (recentRate < cfg.min_rate) continue;
    const baselineEntry = baseline.get(
      `${row.tenant_id}|${row.manifest_id}|${row.variant}|${row.tool}`,
    );
    const baselineRate =
      baselineEntry && baselineEntry.total > 0 ? baselineEntry.errors / baselineEntry.total : 0;
    // No baseline → only flag if the absolute recent rate is itself high.
    // With a baseline, require recent ≥ factor × baseline.
    const triggered =
      baselineEntry === undefined
        ? recentRate >= cfg.min_rate * 2
        : recentRate >= Math.max(cfg.min_rate, baselineRate * cfg.baseline_factor);
    if (!triggered) continue;
    // Pick the dominant error_code from the breakdown so operators see
    // *what kind* of failure is spiking, not just that one is.
    const codes =
      breakdown.get(`${row.tenant_id}|${row.manifest_id}|${row.variant}|${row.tool}`) ?? [];
    const dominant = codes.reduce<{ error_code: string | null; count: number } | null>(
      (best, cur) => (best === null || cur.count > best.count ? cur : best),
      null,
    );
    flagged.push({
      tenant_id: row.tenant_id,
      manifest_id: row.manifest_id,
      variant: row.variant,
      tool: row.tool,
      error_code: dominant?.error_code ?? null,
      recent_rate: recentRate,
      baseline_rate: baselineRate,
      recent_count: row.total,
    });
  }

  for (const f of flagged) {
    // The detector runs once per cron tick, outside any tenant's
    // request scope, but it knows each flagged row's tenant from the
    // GROUP BY. Use `recordEventDetached` so the event lands under the
    // *right* tenant rather than whatever anonymous tenant happens to
    // own the cron-installed context.
    recordEventDetached(env, {
      tenantId: f.tenant_id,
      eventType: 'anomaly_detected',
      manifestId: f.manifest_id,
      status: 'alert',
      payload: {
        tool: f.tool,
        variant: f.variant,
        error_code: f.error_code,
        recent_rate: Number(f.recent_rate.toFixed(3)),
        baseline_rate: Number(f.baseline_rate.toFixed(3)),
        recent_count: f.recent_count,
        window_ms: RECENT_WINDOW_MS,
      },
    });
    recordCounter('orchestrator_anomalies', {
      manifest_id: f.manifest_id,
      variant: f.variant,
      tool: f.tool,
      error_code: f.error_code ?? '',
    });
  }

  // Auto-rollback: zero the canary weight only when the spike is on the
  // *canary* variant itself. `tool_call` rows now carry `manifest_variant`
  // (stamped by the react loop from the resolved variant), so a bad stable
  // version no longer drags down a healthy canary — that false positive is
  // gone. Spikes on `stable` (or untagged legacy rows, variant `''`) still
  // alert via `anomaly_detected` but never trigger a rollback. The dominant
  // `error_code` on the emitted `auto_rollback` event tells operators which
  // class of failure triggered it.
  //
  // De-duped by (tenant, manifest) so a single canary with errors across
  // multiple tools rolls back exactly once.
  const seen = new Set<string>();
  for (const f of flagged) {
    if (f.variant !== 'canary') continue;
    const key = `${f.tenant_id}#${f.manifest_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const active = await getActive(env, f.tenant_id, f.manifest_id);
    if (!active || active.canary_weight === 0 || active.canary_version === null) continue;
    const beforeVersion = active.canary_version;
    const beforeWeight = active.canary_weight;
    await clearCanary(env, {
      tenantId: f.tenant_id,
      name: f.manifest_id,
      clearVersion: false,
      updatedBy: 'system:anomaly-detector',
    });
    recordEventDetached(env, {
      tenantId: f.tenant_id,
      eventType: 'auto_rollback',
      manifestId: f.manifest_id,
      status: 'rolled_back',
      payload: {
        reason: 'anomaly_detected',
        triggered_by: {
          tool: f.tool,
          variant: f.variant,
          error_code: f.error_code,
          recent_rate: f.recent_rate,
        },
        canary_version_before: beforeVersion,
        canary_weight_before: beforeWeight,
        stable_version: active.version,
      },
    });
    recordEventDetached(env, {
      tenantId: f.tenant_id,
      eventType: 'manifest_canary_cleared',
      manifestId: f.manifest_id,
      status: 'auto_rollback',
      payload: {
        canary_version_before: beforeVersion,
        canary_weight_before: beforeWeight,
        stable_version: active.version,
      },
    });
    recordCounter('orchestrator_auto_rollbacks', {
      manifest_id: f.manifest_id,
    });
  }

  return { flagged };
}
