/**
 * Audit log writer + reader.
 *
 * Hot path: `recordEvent` enqueues onto `AUDIT_QUEUE`. The queue consumer
 * (see `index.ts:queue`) batches up to 50 events per pull and writes them
 * to D1 in a single batched statement. This keeps the wrapper code free
 * of D1 round-trip latency on every tool call.
 *
 * When no queue is wired (unit tests with a stub Env, or when the binding
 * fails) we fall back to `execCtx.waitUntil` for a best-effort direct write.
 */

import { getContext } from '../context';
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
    const send = queue
      .send(event, { contentType: 'json' })
      .catch((err: unknown) => console.error('audit enqueue failed', err));
    if (execCtx) execCtx.waitUntil(send);
    else void send;
    return;
  }
  // No queue binding and no DB binding (unit tests with a stub env):
  // log the event and move on. Production envs always have either the
  // queue or the DB wired.
  if (!env.DB) {
    console.log(JSON.stringify({ audit: event }));
    return;
  }
  const write = persistOne(env, event).catch((err) => console.error('audit persist failed', err));
  if (execCtx) execCtx.waitUntil(write);
  else void write;
}

async function persistOne(env: Env, event: AuditEvent): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events
        (id, tenant_id, ts, event_type, manifest_id, principal_subj, status, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      event.id,
      event.tenant_id,
      event.ts,
      event.event_type,
      event.manifest_id,
      event.principal_subject,
      event.status,
      JSON.stringify(event.payload),
    )
    .run();
}

/**
 * Called by the queue consumer. Batches inserts into one D1 `batch()` call.
 * D1 supports up to ~100 statements per batch; we cap to 50 to match the
 * consumer's `max_batch_size` and leave headroom for retries.
 */
export async function persistBatch(env: Env, events: AuditEvent[]): Promise<void> {
  if (events.length === 0) return;
  const stmt = env.DB.prepare(
    `INSERT INTO audit_events
        (id, tenant_id, ts, event_type, manifest_id, principal_subj, status, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const batch = events.map((e) =>
    stmt.bind(
      e.id,
      e.tenant_id,
      e.ts,
      e.event_type,
      e.manifest_id,
      e.principal_subject,
      e.status,
      JSON.stringify(e.payload),
    ),
  );
  await env.DB.batch(batch);
}

export interface ListOptions {
  tenantId: string;
  status?: string;
  limit?: number;
}

export async function listEvents(env: Env, opts: ListOptions): Promise<AuditEvent[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const stmt = opts.status
    ? env.DB.prepare(
        `SELECT * FROM audit_events
           WHERE tenant_id = ? AND status = ?
           ORDER BY ts DESC LIMIT ?`,
      ).bind(opts.tenantId, opts.status, limit)
    : env.DB.prepare(
        `SELECT * FROM audit_events
           WHERE tenant_id = ?
           ORDER BY ts DESC LIMIT ?`,
      ).bind(opts.tenantId, limit);

  const rows = await stmt.all<{
    id: string;
    tenant_id: string;
    ts: number;
    event_type: AuditEventType;
    manifest_id: string;
    principal_subj: string;
    status: string;
    payload_json: string;
  }>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    ts: row.ts,
    event_type: row.event_type,
    manifest_id: row.manifest_id,
    principal_subject: row.principal_subj,
    status: row.status,
    payload: safeJson(row.payload_json),
  }));
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
