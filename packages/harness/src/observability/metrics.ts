/**
 * Counter / histogram emission.
 *
 * Hot path: when the `METRICS` Analytics Engine binding is wired on the
 * Env, each call lands a data point on the `felix_metrics` dataset —
 * queryable with the Analytics Engine SQL API. When the binding is
 * absent (unit tests, dev probes without a wrangler.jsonc binding) we
 * emit a structured `console.log` line that `wrangler tail` still
 * surfaces.
 *
 * Data-point shape:
 *   index1 = manifest_id (empty string when absent) — fast slice
 *   blob1  = metric name (e.g. `orchestrator_tool_calls`)
 *   blob2  = kind ('counter' | 'histogram')
 *   blob3+ = `${key}=${value}` for every label entry, sorted by key for
 *            deterministic ordering across runs
 *   double1 = numeric value (count or histogram observation)
 *
 * Analytics Engine accepts ≤32 KB per data point and rejects writes that
 * exceed it. We don't currently emit labels long enough to trip that
 * cap; if a future metric does, truncate at the call site.
 */

import { getContext } from '../context';
import type { Env } from '../env';

export type MetricLabels = Record<string, string | number | undefined>;

function emit(
  name: string,
  kind: 'counter' | 'histogram',
  value: number,
  labels: MetricLabels,
  explicitDataset?: AnalyticsEngineDataset,
): void {
  const dataset = explicitDataset ?? getContext()?.env.METRICS;
  if (dataset) {
    const blobs: string[] = [name, kind];
    const keys = Object.keys(labels).sort();
    for (const k of keys) {
      const v = labels[k];
      if (v !== undefined) blobs.push(`${k}=${String(v)}`);
    }
    const manifestId = labels.manifest_id != null ? String(labels.manifest_id) : '';
    try {
      dataset.writeDataPoint({
        indexes: [manifestId],
        blobs,
        doubles: [value],
      });
      return;
    } catch (err) {
      // AE write failures must never break the request path. Fall through
      // to the structured-log shadow path so the signal still lands.
      console.error('metrics writeDataPoint failed', err);
    }
  }
  console.log(JSON.stringify({ metric: name, kind, value, labels }));
}

export function recordCounter(name: string, labels: MetricLabels = {}, value = 1): void {
  emit(name, 'counter', value, labels);
}

/**
 * Env-taking variant for call sites that run before or outside
 * `runWithContext` (mirrors `recordEventDetached` in audit/store.ts): reads
 * the Analytics Engine binding off the provided Env instead of
 * AsyncLocalStorage, so the data point actually lands when no RequestContext
 * is installed yet.
 */
export function recordCounterDetached(
  env: Env,
  name: string,
  labels: MetricLabels = {},
  value = 1,
): void {
  emit(name, 'counter', value, labels, env.METRICS);
}

export function recordHistogram(name: string, value: number, labels: MetricLabels = {}): void {
  emit(name, 'histogram', value, labels);
}
