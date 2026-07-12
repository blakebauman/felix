/**
 * Audit log writer + reader.
 *
 * Hot path: `recordEvent` enqueues onto `AUDIT_QUEUE`. The queue consumer
 * (see `index.ts:queue`) batches up to 50 events per pull and writes them
 * to Postgres in a single multi-row INSERT. This keeps the wrapper code
 * free of database round-trip latency on every tool call.
 *
 * When no queue is wired (unit tests with a stub Env, or when the binding
 * fails) we fall back to `execCtx.waitUntil` for a best-effort direct write.
 */

import { getContext } from '../context';
import { getDb } from '../db/client';
import type { Env } from '../env';
import { recordCounter } from '../observability/metrics';
import { redactSecrets } from '../security/redact';
import type { AuditEvent, AuditEventType } from './models';

function genId(): string {
  return crypto.randomUUID();
}

export interface RecordOptions {
  tenantId: string;
  eventType: AuditEventType;
  principalSubject?: string;
  manifestId?: string;
  status?: string;
  payload?: Record<string, unknown>;
}

// Cap audit events per request so a runaway tool loop can't fill the queue.
// A single `audit_truncated` marker is emitted when the cap is reached.
const PER_REQUEST_AUDIT_CAP = 200;

export function recordEvent(opts: RecordOptions): AuditEvent {
  const ctx = getContext();
  const limitState = ctx?.limitState;
  if (limitState) {
    if (limitState.auditCount >= PER_REQUEST_AUDIT_CAP) {
      if (!limitState.auditTruncatedEmitted) {
        limitState.auditTruncatedEmitted = true;
        const marker: AuditEvent = {
          id: genId(),
          tenant_id: opts.tenantId,
          ts: Date.now(),
          event_type: opts.eventType,
          manifest_id: opts.manifestId ?? '',
          principal_subject: opts.principalSubject ?? '',
          status: 'audit_truncated',
          payload: { reason: 'per_request_cap', cap: PER_REQUEST_AUDIT_CAP },
        };
        if (ctx) enqueueOrFallback(ctx.env, marker, ctx.execCtx);
        return marker;
      }
      // Past the cap: drop the event but keep the loss observable — track a
      // running count on the request and emit a counter so operators see *how
      // much* was shed, not just that truncation happened.
      limitState.droppedAfterTruncation += 1;
      recordCounter('orchestrator_audit_dropped', {
        manifest_id: opts.manifestId ?? '',
        event_type: opts.eventType,
      });
      return {
        id: '',
        tenant_id: opts.tenantId,
        ts: Date.now(),
        event_type: opts.eventType,
        manifest_id: opts.manifestId ?? '',
        principal_subject: opts.principalSubject ?? '',
        status: 'dropped_after_truncation',
        payload: { dropped_after_truncation: limitState.droppedAfterTruncation },
      };
    }
    limitState.auditCount += 1;
  }
  const event: AuditEvent = {
    id: genId(),
    tenant_id: opts.tenantId,
    ts: Date.now(),
    event_type: opts.eventType,
    manifest_id: opts.manifestId ?? '',
    principal_subject: opts.principalSubject ?? '',
    status: opts.status ?? '',
    payload: opts.payload ? redactSecrets(opts.payload) : {},
  };

  if (ctx) {
    enqueueOrFallback(ctx.env, event, ctx.execCtx);
  } else {
    console.log(JSON.stringify({ audit: event }));
  }
  return event;
}

/**
 * Detached variant of `recordEvent` for callers that don't have an active
 * `RequestContext` (e.g. `app.onError`, which fires after the auth
 * middleware's `runWithContext` scope has unwound). Skips the per-request
 * audit cap — detached events are rare and always worth recording.
 */
export function recordEventDetached(
  env: Env,
  opts: RecordOptions,
  execCtx?: ExecutionContext,
): AuditEvent {
  const event: AuditEvent = {
    id: genId(),
    tenant_id: opts.tenantId,
    ts: Date.now(),
    event_type: opts.eventType,
    manifest_id: opts.manifestId ?? '',
    principal_subject: opts.principalSubject ?? '',
    status: opts.status ?? '',
    payload: opts.payload ? redactSecrets(opts.payload) : {},
  };
  enqueueOrFallback(env, event, execCtx);
  return event;
}

function enqueueOrFallback(env: Env, event: AuditEvent, execCtx?: ExecutionContext): void {
  const queue = env.AUDIT_QUEUE;
  if (queue) {
    // Happy path: enqueue and let the batched consumer persist. If the send
    // REJECTS (queue pressure / transient error) we must not silently drop the
    // event — fall back to the same direct write the no-queue path uses so
    // the audit/compliance surface stays durable under load.
    const send = queue.send(event, { contentType: 'json' }).catch((err: unknown) => {
      console.error('audit enqueue failed', err);
      recordCounter('orchestrator_audit_enqueue_fallback', { manifest_id: event.manifest_id });
      return directWrite(env, event);
    });
    if (execCtx) execCtx.waitUntil(send);
    else void send;
    return;
  }
  // No queue binding: write directly (or log if no database either — unit
  // tests with a stub env). Production envs always have either the queue or
  // the Hyperdrive binding wired.
  const write = directWrite(env, event);
  if (execCtx) execCtx.waitUntil(write);
  else void write;
}

/**
 * Best-effort direct persistence used both when no queue is wired and as the
 * fallback when `AUDIT_QUEUE.send` rejects. Guarded on `env.HYPERDRIVE`; if
 * Postgres is absent (or the insert throws) the event is logged as a last
 * resort so the loss is at least observable.
 */
async function directWrite(env: Env, event: AuditEvent): Promise<void> {
  if (!env.HYPERDRIVE) {
    console.log(JSON.stringify({ audit: event }));
    return;
  }
  try {
    await persistOne(env, event);
  } catch (err) {
    console.error('audit persist failed', err);
    console.log(JSON.stringify({ audit: event }));
  }
}

async function persistOne(env: Env, event: AuditEvent): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO audit_events
        (id, tenant_id, ts, event_type, manifest_id, principal_subj, status, payload_json)
      VALUES (${event.id}, ${event.tenant_id}, ${event.ts}, ${event.event_type},
              ${event.manifest_id}, ${event.principal_subject}, ${event.status},
              ${event.payload as Record<string, unknown>})
  `;
}

/**
 * Called by the queue consumer. One multi-row INSERT per pull (≤50 rows —
 * the consumer's `max_batch_size`), atomic by virtue of being a single
 * statement.
 */
export async function persistBatch(env: Env, events: AuditEvent[]): Promise<void> {
  if (events.length === 0) return;
  const sql = getDb(env);
  // NOTE: jsonb values are passed as raw objects — postgres.js Describes the
  // statement, sees the jsonb param type, and JSON-serializes once. A
  // pre-stringified value would be double-encoded into a jsonb string scalar.
  const rows = events.map((e) => ({
    id: e.id,
    tenant_id: e.tenant_id,
    ts: e.ts,
    event_type: e.event_type,
    manifest_id: e.manifest_id,
    principal_subj: e.principal_subject,
    status: e.status,
    payload_json: e.payload as Record<string, unknown>,
  }));
  await sql`INSERT INTO audit_events ${sql(rows)}`;
}

export interface ListOptions {
  tenantId: string;
  status?: string;
  limit?: number;
}

export async function listEvents(env: Env, opts: ListOptions): Promise<AuditEvent[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const sql = getDb(env);
  const rows = await sql<
    {
      id: string;
      tenant_id: string;
      ts: number;
      event_type: AuditEventType;
      manifest_id: string;
      principal_subj: string;
      status: string;
      payload_json: Record<string, unknown>;
    }[]
  >`
    SELECT * FROM audit_events
      WHERE tenant_id = ${opts.tenantId}
      ${opts.status ? sql`AND status = ${opts.status}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
  `;
  return rows.map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    ts: row.ts,
    event_type: row.event_type,
    manifest_id: row.manifest_id,
    principal_subject: row.principal_subj,
    status: row.status,
    payload: row.payload_json ?? {},
  }));
}

/**
 * The lifecycle state of a queue-transport dispatch, reconstructed from the
 * tenant's `queue_dispatch` / `queue_complete` / `queue_expired` audit rows
 * for a single `tool_call_id`.
 *
 * Used by the internal write-back route to prove that an inbound
 * `tool_result` pairs to a REAL, still-outstanding dispatch on the caller's
 * tenant + thread before it lands anything in a session. Without this a
 * holder of the fleet-global `CONSUMER_SHARED_SECRET` could inject an
 * arbitrary `tool_result` into any tenant's thread.
 */
export interface QueueDispatchState {
  /**
   * The originating `queue_dispatch` row, if one exists for this
   * (tenant, tool_call_id). Absent when nothing was ever dispatched under
   * that id — i.e. a forged / cross-tenant write-back.
   */
  dispatch?: { threadId: string; jobId: string; manifestId: string };
  /**
   * True when a `queue_complete` or `queue_expired` row already exists for
   * this (tenant, tool_call_id) — the cycle is settled, so a further
   * write-back is a replay and must be rejected (one-shot semantics).
   */
  resolved: boolean;
}

/**
 * Reconstruct the {@link QueueDispatchState} for one `tool_call_id` from the
 * tenant's queue-lifecycle audit rows. Tenant-scoped, parameterized, matched
 * on `tool_call_id` via the jsonb `->>` operator.
 *
 * NOTE (eventual consistency): `queue_dispatch` / `queue_complete` rows are
 * emitted through `AUDIT_QUEUE` and batched into Postgres by the audit consumer,
 * so there is a short window (bounded by the audit batch timeout) where a
 * just-emitted row is not yet visible here. A legitimate consumer that
 * completes faster than that window should treat the resulting rejection as
 * transient and retry; queue-transport tools are meant for long-running work
 * where the dispatch row is long settled by completion time.
 */
export async function findQueueDispatchState(
  env: Env,
  tenantId: string,
  toolCallId: string,
): Promise<QueueDispatchState> {
  const sql = getDb(env);
  const rows = await sql<
    {
      event_type: string;
      manifest_id: string;
      thread_id: string | null;
      job_id: string | null;
    }[]
  >`
    SELECT event_type, manifest_id,
           payload_json->>'thread_id' AS thread_id,
           payload_json->>'job_id' AS job_id
      FROM audit_events
      WHERE tenant_id = ${tenantId}
        AND event_type IN ('queue_dispatch', 'queue_complete', 'queue_expired')
        AND payload_json->>'tool_call_id' = ${toolCallId}
  `;

  let dispatch: QueueDispatchState['dispatch'];
  let resolved = false;
  for (const row of rows) {
    if (row.event_type === 'queue_dispatch') {
      dispatch = {
        threadId: row.thread_id ?? '',
        jobId: row.job_id ?? '',
        manifestId: row.manifest_id ?? '',
      };
    } else {
      resolved = true;
    }
  }
  return { dispatch, resolved };
}
