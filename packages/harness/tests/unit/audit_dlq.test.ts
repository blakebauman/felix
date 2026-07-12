/**
 * Audit DLQ drain.
 *
 * Pins the contract: dead-lettered audit events are re-persisted to the
 * database best-effort and the loss is made observable via the
 * `orchestrator_audit_dlq_received` counter. Postgres is stubbed as an
 * in-memory sink; the metrics binding is stubbed to capture the counter.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../src/audit/models';
import type { Env } from '../../src/env';
import { drainAuditDlq } from '../../src/jobs/audit-dlq';
import { makeFakeSql, withFakeDb } from '../helpers/fake-sql';

function ev(id: string): AuditEvent {
  return {
    id,
    tenant_id: 't1',
    ts: 123,
    event_type: 'tool_call',
    manifest_id: 'm1',
    principal_subject: '',
    status: 'error',
    payload: {},
  };
}

interface Captured {
  metrics: Array<{ blobs: string[]; doubles: number[] }>;
}

function fakeEnv(rows: AuditEvent[], captured: Captured, opts: { failBatch?: boolean } = {}) {
  const { sql } = makeFakeSql((q) => {
    // persistBatch is one multi-row INSERT — `sql(rows)` renders as a single
    // array param. Mirror the old batch semantics: the multi-row path throws
    // when configured, so the caller must fall back to per-row inserts.
    const inserted = q.params[0] as Array<{ id: string }>;
    if (opts.failBatch && inserted.length > 1) throw new Error('batch boom');
    for (const r of inserted) rows.push(ev(r.id));
    return inserted.length;
  });
  const env = {
    HYPERDRIVE: { connectionString: 'postgresql://fake' },
    METRICS: {
      writeDataPoint(pt: { blobs?: string[]; doubles?: number[] }) {
        captured.metrics.push({ blobs: pt.blobs ?? [], doubles: pt.doubles ?? [] });
      },
    },
  } as unknown as Env;
  return { env, sql };
}

describe('drainAuditDlq', () => {
  it('re-persists dead-lettered events to Postgres and counts them', async () => {
    const rows: AuditEvent[] = [];
    const captured: Captured = { metrics: [] };
    const { env, sql } = fakeEnv(rows, captured);

    const result = await withFakeDb(env, sql, () => drainAuditDlq(env, [ev('a'), ev('b')]));

    expect(result.received).toBe(2);
    expect(result.persisted).toBe(2);
    expect(result.failed_ids).toEqual([]);
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);

    // Counter emitted with the batch size.
    const counter = captured.metrics.find((m) =>
      m.blobs.includes('orchestrator_audit_dlq_received'),
    );
    expect(counter).toBeDefined();
    expect(counter?.doubles[0]).toBe(2);
  });

  it('falls back to per-row writes when the batch insert fails', async () => {
    const rows: AuditEvent[] = [];
    const captured: Captured = { metrics: [] };
    const { env, sql } = fakeEnv(rows, captured, { failBatch: true });

    const result = await withFakeDb(env, sql, () => drainAuditDlq(env, [ev('a'), ev('b')]));

    expect(result.persisted).toBe(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('reports events as failed when no database is bound', async () => {
    const env = { METRICS: { writeDataPoint: () => {} } } as unknown as Env;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await drainAuditDlq(env, [ev('a')]);

    expect(result.received).toBe(1);
    expect(result.persisted).toBe(0);
    expect(result.failed_ids).toEqual(['a']);
    logSpy.mockRestore();
  });

  it('is a no-op on an empty batch', async () => {
    const captured: Captured = { metrics: [] };
    const { env } = fakeEnv([], captured);
    const result = await drainAuditDlq(env, []);
    expect(result).toEqual({ received: 0, persisted: 0, failed_ids: [] });
    expect(captured.metrics).toEqual([]);
  });
});
