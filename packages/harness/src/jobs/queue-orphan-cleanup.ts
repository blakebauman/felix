/**
 * Orphan cleanup for queue-transport tool dispatches.
 *
 * Cycle: `QueueExecutor` emits a `queue_dispatch` audit row when it
 * enqueues a job. The consumer is supposed to emit `queue_complete`
 * when it lands a `tool_result` (or `queue_expired` when it decides
 * not to). When neither happens — the consumer crashed, the queue
 * binding was misconfigured, the consumer Worker was redeployed mid-
 * batch, etc. — the cycle stays unresolved on the session and the
 * client keeps seeing a pending tool_call on every `tasks/resubscribe`.
 *
 * This sweep runs from `scheduled` on every cron tick. It:
 *
 *   1. Reads recent queue lifecycle audit rows (last `windowMs` ms).
 *   2. Pairs `queue_dispatch` rows to `queue_complete` / `queue_expired`
 *      rows by `job_id` (scoped to tenant).
 *   3. For dispatches with no completion AND older than `ageThresholdMs`,
 *      writes a synthetic `tool_result` event back to the session
 *      ("[expired] queue tool …") and emits a `queue_expired` audit row.
 *
 * The synthetic tool_result is what resolves the cycle — once it lands,
 * `session.wake()` reports `pendingToolCalls: []` and the next model
 * step (on this thread or the next `tasks/resubscribe`) sees a closed
 * cycle. The model receives a clear error and can apologize to the user.
 */

import { recordEvent } from '../audit/store';
import { getDb } from '../db/client';
import type { Env } from '../env';
import { conversationStub } from '../memory/conversation-do';

export interface OrphanSweepOpts {
  /**
   * How old a `queue_dispatch` row has to be (in ms) before we'll declare
   * it orphaned. Default 30 minutes — long enough that a slow consumer
   * won't get its result discarded, short enough that a stuck user gets
   * a usable error within one resubscribe cycle.
   */
  ageThresholdMs?: number;
  /** Upper bound on how far back we look for dispatch rows. Default 24h. */
  windowMs?: number;
  /** Bound on the rows we'll cancel in a single sweep. Default 50. */
  maxPerSweep?: number;
}

interface AuditRow {
  id: string;
  tenant_id: string;
  ts: number;
  event_type: string;
  manifest_id: string;
  principal_subj: string;
  payload_json: Record<string, unknown>;
}

interface DispatchRecord {
  job_id: string;
  tenant_id: string;
  ts: number;
  manifest_id: string;
  principal_subject: string;
  tool: string;
  tool_call_id: string;
  thread_id: string;
}

export async function sweepOrphanQueueDispatches(
  env: Env,
  opts: OrphanSweepOpts = {},
  now: number = Date.now(),
): Promise<number> {
  const ageThresholdMs = opts.ageThresholdMs ?? 30 * 60 * 1000;
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000;
  const maxPerSweep = opts.maxPerSweep ?? 50;
  const cutoffMs = now - windowMs;

  const sql = getDb(env);
  const rows = await sql<AuditRow[]>`
    SELECT id, tenant_id, ts, event_type, manifest_id, principal_subj, payload_json
      FROM audit_events
      WHERE event_type IN ('queue_dispatch', 'queue_complete', 'queue_expired')
        AND ts >= ${cutoffMs}
      ORDER BY ts ASC
  `;

  const completedJobs = new Set<string>();
  const dispatches: DispatchRecord[] = [];

  for (const row of rows) {
    const payload = row.payload_json ?? {};
    const jobId = String(payload.job_id ?? '');
    if (!jobId) continue;
    const key = `${row.tenant_id}#${jobId}`;
    if (row.event_type === 'queue_dispatch') {
      dispatches.push({
        job_id: jobId,
        tenant_id: row.tenant_id,
        ts: row.ts,
        manifest_id: row.manifest_id,
        principal_subject: row.principal_subj,
        tool: String(payload.tool ?? ''),
        tool_call_id: String(payload.tool_call_id ?? ''),
        thread_id: String(payload.thread_id ?? ''),
      });
    } else {
      completedJobs.add(key);
    }
  }

  const orphans = dispatches
    .filter(
      (d) =>
        d.thread_id &&
        d.tool_call_id &&
        !completedJobs.has(`${d.tenant_id}#${d.job_id}`) &&
        now - d.ts > ageThresholdMs,
    )
    .slice(0, maxPerSweep);

  for (const orphan of orphans) {
    const ageMs = now - orphan.ts;
    try {
      // Append a synthetic [expired] tool_result so the cycle resolves
      // and the model can produce a graceful apology on the next turn.
      await conversationStub(env, orphan.thread_id).fetch('https://do/events', {
        method: 'POST',
        body: JSON.stringify({
          events: [
            {
              kind: 'tool_result',
              role: 'tool',
              tool_call_id: orphan.tool_call_id,
              name: orphan.tool,
              content:
                `[expired] queue tool '${orphan.tool}' (job_id=${orphan.job_id}) did not ` +
                `complete within ${Math.round(ageMs / 60000)} minutes. The consumer is unreachable ` +
                'or the job was dropped. Apologize to the user and offer to retry.',
              metadata: { job_id: orphan.job_id, source: 'orphan-cleanup', age_ms: ageMs },
            },
          ],
        }),
      });
    } catch (err) {
      console.error('orphan cleanup: failed to write tool_result back to session', {
        thread_id: orphan.thread_id,
        job_id: orphan.job_id,
        error: String((err as Error).message ?? err),
      });
      continue;
    }

    recordEvent({
      tenantId: orphan.tenant_id,
      eventType: 'queue_expired',
      principalSubject: orphan.principal_subject,
      manifestId: orphan.manifest_id,
      status: 'expired',
      payload: {
        job_id: orphan.job_id,
        tool: orphan.tool,
        tool_call_id: orphan.tool_call_id,
        thread_id: orphan.thread_id,
        age_ms: ageMs,
      },
    });
  }

  return orphans.length;
}
