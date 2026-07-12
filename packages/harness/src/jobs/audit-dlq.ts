/**
 * Audit dead-letter-queue drain.
 *
 * The `felix-audit-*` queue's consumer (`apps/api/src/index.ts:queue`) retries
 * a failing message up to `max_retries`, after which Cloudflare dead-letters it
 * onto `felix-audit-dlq-*`. Without a consumer those events are lost silently —
 * a compliance hole, since the audit log is the durable record.
 *
 * This drain is the DLQ consumer's core: it emits an
 * `orchestrator_audit_dlq_received` counter so the drop is observable, then
 * makes a best-effort direct-D1 write of each dead-lettered `AuditEvent` (the
 * same `persistBatch` the main consumer uses, with a per-row fallback so one
 * poison row doesn't sink the rest). The caller ACKs the DLQ messages
 * regardless of persist outcome — a DLQ has no further dead-letter, so retrying
 * would only loop; the counter + logs surface any residual loss.
 */

import type { AuditEvent } from '../audit/models';
import { persistBatch } from '../audit/store';
import type { Env } from '../env';
import { recordCounterDetached } from '../observability/metrics';

export interface AuditDlqDrainResult {
  received: number;
  persisted: number;
  /** Ids of events that could not be persisted (already logged for triage). */
  failed_ids: string[];
}

/**
 * Drain a batch of dead-lettered audit events. Best-effort persistence: tries
 * the batched insert first, then falls back to per-row so partial success is
 * possible. Never throws — the DLQ consumer must always ack.
 */
export async function drainAuditDlq(env: Env, events: AuditEvent[]): Promise<AuditDlqDrainResult> {
  const result: AuditDlqDrainResult = { received: events.length, persisted: 0, failed_ids: [] };
  if (events.length === 0) return result;

  recordCounterDetached(env, 'orchestrator_audit_dlq_received', {}, events.length);

  if (!env.DB) {
    // No D1 to recover into (unit stub / misconfig): log so the events aren't
    // lost without a trace, and report them all as failed.
    for (const e of events) console.log(JSON.stringify({ audit_dlq_unrecovered: e }));
    result.failed_ids = events.map((e) => e.id);
    return result;
  }

  try {
    await persistBatch(env, events);
    result.persisted = events.length;
    return result;
  } catch (err) {
    console.error('audit DLQ batch persist failed, falling back to per-row', err);
  }

  for (const e of events) {
    try {
      await persistBatch(env, [e]);
      result.persisted += 1;
    } catch (rowErr) {
      console.error('audit DLQ row persist failed', rowErr);
      console.log(JSON.stringify({ audit_dlq_unrecovered: e }));
      result.failed_ids.push(e.id);
    }
  }
  return result;
}
