/**
 * Audit aggregations — tenant-scoped roll-ups over `audit_events`.
 *
 * Hot path query for `/audit/metrics`: per `(manifest_id, tool,
 * transport, status, error_code)` counts and average duration for the
 * `tool_call` event family within a `since`-bounded window. The
 * `error_code` dimension is what makes Phase-2 anomaly detection
 * tractable — every transport tags failures with a stable code via
 * `toolErrorOutput` / `inferErrorCode` (see `src/tools/errors.ts`), and
 * this query exposes the rate per code so operators can see whether the
 * recent uptick is `provider_error`, `rate_limited`, `timeout`, etc.
 *
 * Composite `(tenant_id, id)` PK on `audit_events`, plus the
 * `(tenant_id, ts DESC)` index, keep this cheap even at moderate
 * volumes; if it ever stops being cheap, the right move is to land the
 * tool_call event stream in Pipelines → R2 → Parquet and
 * query that.
 */

import type { Env } from '../env';

export interface ToolCallMetricsQuery {
  tenantId: string;
  /** Lower bound (ms since epoch). Inclusive. */
  since: number;
  /** Upper bound (ms since epoch). Inclusive. Defaults to "now". */
  until?: number;
  /** Optional filter: only this manifest_id. */
  manifestId?: string;
  /** Max rows. Defaults to 100, hard-capped at 500. */
  limit?: number;
}

export interface ToolCallMetricsRow {
  manifest_id: string;
  tool: string;
  transport: string;
  status: string;
  /** Null when status is 'ok' or the event predates the taxonomy. */
  error_code: string | null;
  count: number;
  avg_duration_ms: number | null;
}

const ROW_HARD_CAP = 500;

/**
 * `json_extract` returns SQLite JSON1's null for missing keys; we want
 * those to surface as JS `null` so downstream callers can branch on it.
 */
export async function getToolCallMetrics(
  env: Env,
  opts: ToolCallMetricsQuery,
): Promise<ToolCallMetricsRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), ROW_HARD_CAP);
  const until = opts.until ?? Date.now();
  const sql = `
    SELECT
      manifest_id,
      COALESCE(json_extract(payload_json, '$.tool'), '') AS tool,
      COALESCE(json_extract(payload_json, '$.transport'), '') AS transport,
      status,
      json_extract(payload_json, '$.error_code') AS error_code,
      COUNT(*) AS count,
      AVG(json_extract(payload_json, '$.duration_ms')) AS avg_duration_ms
    FROM audit_events
    WHERE tenant_id = ?
      AND event_type = 'tool_call'
      AND ts >= ?
      AND ts <= ?
      ${opts.manifestId ? 'AND manifest_id = ?' : ''}
    GROUP BY manifest_id, tool, transport, status, error_code
    ORDER BY count DESC
    LIMIT ?
  `;
  const binds: unknown[] = [opts.tenantId, opts.since, until];
  if (opts.manifestId) binds.push(opts.manifestId);
  binds.push(limit);
  const stmt = env.DB.prepare(sql).bind(...binds);
  const result = await stmt.all<{
    manifest_id: string;
    tool: string;
    transport: string;
    status: string;
    error_code: string | null;
    count: number;
    avg_duration_ms: number | null;
  }>();
  return (result.results ?? []).map((row) => ({
    manifest_id: row.manifest_id,
    tool: row.tool,
    transport: row.transport,
    status: row.status,
    error_code: row.error_code,
    count: Number(row.count),
    avg_duration_ms: row.avg_duration_ms == null ? null : Number(row.avg_duration_ms),
  }));
}
