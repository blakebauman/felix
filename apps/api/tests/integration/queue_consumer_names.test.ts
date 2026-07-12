/**
 * Regression: the audit queue consumer must accept the env-suffixed queue
 * names (felix-audit-staging / felix-audit-prod), not just dev's
 * felix-audit. The old exact match made every deployed env's audit events
 * fall through unacked — they cycled max_retries and persisted only via
 * the dead-letter drain (invisible in the D1 era; caught by the staging
 * smoke test during the Postgres cutover).
 */

import { env } from 'cloudflare:test';
import type { AuditEvent } from '@felix/harness/audit/models';
import { getDb } from '@felix/harness/db/client';
import type { Env as AppEnv } from '@felix/harness/env';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index';

const testEnv = env as unknown as AppEnv;

function ev(id: string, tenant: string): AuditEvent {
  return {
    id,
    tenant_id: tenant,
    ts: Date.now(),
    event_type: 'tool_call',
    manifest_id: 'quick',
    principal_subject: '',
    status: 'ok',
    payload: { tool: 'calculator' },
  };
}

function fakeBatch(queue: string, events: AuditEvent[]) {
  const acked: string[] = [];
  const retried: string[] = [];
  return {
    acked,
    retried,
    batch: {
      queue,
      messages: events.map((body) => ({
        id: body.id,
        timestamp: new Date(),
        attempts: 1,
        body,
        ack: () => acked.push(body.id),
        retry: () => retried.push(body.id),
      })),
    } as unknown as MessageBatch<AuditEvent>,
  };
}

const execCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe('audit queue consumer name matching', () => {
  it('persists and acks batches from env-suffixed queues (felix-audit-staging)', async () => {
    const tenant = `queue-name-${crypto.randomUUID().slice(0, 8)}`;
    const { batch, acked, retried } = fakeBatch('felix-audit-staging', [ev('e1', tenant)]);
    await worker.queue(batch, testEnv, execCtx);
    expect(acked).toEqual(['e1']);
    expect(retried).toEqual([]);
    const rows = await getDb(testEnv)<{ id: string }[]>`
      SELECT id FROM audit_events WHERE tenant_id = ${tenant}
    `;
    expect(rows.map((r) => r.id)).toEqual(['e1']);
  });

  it('still ignores unrelated queues', async () => {
    const tenant = `queue-name-${crypto.randomUUID().slice(0, 8)}`;
    const { batch, acked } = fakeBatch('some-other-queue', [ev('e2', tenant)]);
    await worker.queue(batch, testEnv, execCtx);
    expect(acked).toEqual([]);
    const rows = await getDb(testEnv)<{ id: string }[]>`
      SELECT id FROM audit_events WHERE tenant_id = ${tenant}
    `;
    expect(rows).toEqual([]);
  });
});
