/**
 * Customer + behavior-event store (D1). Every query is tenant-scoped via the
 * composite (tenant_id, id) primary key, matching the rest of the schema.
 *
 * Behavior recording is best-effort telemetry — `recordBehaviorEvent` never
 * throws into a caller; it logs and returns. Recommendation seeding and
 * abandoned-cart detection both read back through this store.
 */

import type { Env } from '@felix/harness/env';
import {
  type BehaviorEvent,
  BehaviorEventSchema,
  type BehaviorType,
  type Customer,
  CustomerSchema,
} from './models';

interface CustomerRow {
  tenant_id: string;
  id: string;
  email: string;
  external_ref: string;
  attrs_json: string;
  created_at: number;
  last_seen_at: number;
}

interface BehaviorRow {
  tenant_id: string;
  id: string;
  customer_id: string;
  thread_id: string;
  type: string;
  product_id: string;
  ts: number;
  metadata_json: string;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function rowToCustomer(row: CustomerRow): Customer {
  return CustomerSchema.parse({
    tenant_id: row.tenant_id,
    id: row.id,
    email: row.email,
    external_ref: row.external_ref,
    attrs: safeJson(row.attrs_json),
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
  });
}

function rowToEvent(row: BehaviorRow): BehaviorEvent {
  return BehaviorEventSchema.parse({
    tenant_id: row.tenant_id,
    id: row.id,
    customer_id: row.customer_id,
    thread_id: row.thread_id,
    type: row.type,
    product_id: row.product_id,
    ts: row.ts,
    metadata: safeJson(row.metadata_json),
  });
}

export async function upsertCustomer(env: Env, customer: Customer): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO customers (tenant_id, id, email, external_ref, attrs_json, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       email = excluded.email,
       external_ref = excluded.external_ref,
       attrs_json = excluded.attrs_json,
       last_seen_at = excluded.last_seen_at`,
  )
    .bind(
      customer.tenant_id,
      customer.id,
      customer.email,
      customer.external_ref,
      JSON.stringify(customer.attrs),
      customer.created_at,
      customer.last_seen_at,
    )
    .run();
}

export async function getCustomer(
  env: Env,
  tenantId: string,
  id: string,
): Promise<Customer | null> {
  const row = await env.DB.prepare('SELECT * FROM customers WHERE tenant_id = ? AND id = ? LIMIT 1')
    .bind(tenantId, id)
    .first<CustomerRow>();
  return row ? rowToCustomer(row) : null;
}

/** Link a conversation thread to a customer (cross-session identity). */
export async function linkSessionToCustomer(
  env: Env,
  tenantId: string,
  threadId: string,
  customerId: string,
  nowMs: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO customer_sessions (tenant_id, thread_id, customer_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (tenant_id, thread_id) DO UPDATE SET customer_id = excluded.customer_id`,
  )
    .bind(tenantId, threadId, customerId, nowMs)
    .run();
}

/** Resolve the customer id linked to a thread, if any. */
export async function getSessionCustomer(
  env: Env,
  tenantId: string,
  threadId: string,
): Promise<string | null> {
  if (!threadId) return null;
  const row = await env.DB.prepare(
    'SELECT customer_id FROM customer_sessions WHERE tenant_id = ? AND thread_id = ? LIMIT 1',
  )
    .bind(tenantId, threadId)
    .first<{ customer_id: string }>();
  return row?.customer_id ?? null;
}

/**
 * Backfill the customer id onto this thread's prior anonymous behavior events,
 * so a shopper who identifies mid-session keeps the history they built up while
 * anonymous. Best-effort.
 */
export async function attachThreadEventsToCustomer(
  env: Env,
  tenantId: string,
  threadId: string,
  customerId: string,
): Promise<void> {
  if (!threadId || !customerId) return;
  try {
    await env.DB.prepare(
      `UPDATE behavior_events SET customer_id = ?
        WHERE tenant_id = ? AND thread_id = ? AND customer_id = ''`,
    )
      .bind(customerId, tenantId, threadId)
      .run();
  } catch (err) {
    console.warn('attachThreadEventsToCustomer failed', err);
  }
}

/**
 * Append a behavior event. Best-effort: failures are logged, not thrown, so
 * telemetry never breaks a shopping action. `id`/`ts` are stamped here.
 */
export async function recordBehaviorEvent(
  env: Env,
  evt: {
    tenant_id: string;
    type: BehaviorType;
    thread_id?: string;
    customer_id?: string;
    product_id?: string;
    ts: number;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO behavior_events
         (tenant_id, id, customer_id, thread_id, type, product_id, ts, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        evt.tenant_id,
        crypto.randomUUID(),
        evt.customer_id ?? '',
        evt.thread_id ?? '',
        evt.type,
        evt.product_id ?? '',
        evt.ts,
        JSON.stringify(evt.metadata ?? {}),
      )
      .run();
  } catch (err) {
    console.warn('recordBehaviorEvent failed', err);
  }
}

/** Recent behavior events for a thread or customer, newest first. */
export async function listRecentBehavior(
  env: Env,
  tenantId: string,
  opts: { threadId?: string; customerId?: string; types?: BehaviorType[]; limit?: number },
): Promise<BehaviorEvent[]> {
  const clauses = ['tenant_id = ?'];
  const binds: unknown[] = [tenantId];
  if (opts.customerId) {
    clauses.push('customer_id = ?');
    binds.push(opts.customerId);
  } else if (opts.threadId) {
    clauses.push('thread_id = ?');
    binds.push(opts.threadId);
  }
  if (opts.types?.length) {
    clauses.push(`type IN (${opts.types.map(() => '?').join(', ')})`);
    binds.push(...opts.types);
  }
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const rows = await env.DB.prepare(
    `SELECT * FROM behavior_events WHERE ${clauses.join(' AND ')} ORDER BY ts DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<BehaviorRow>();
  return (rows.results ?? []).map(rowToEvent);
}

/**
 * Count recent purchases of a product (a demand proxy for velocity-based
 * dynamic pricing). Best-effort: returns 0 on any failure so pricing never
 * fails on a telemetry read.
 */
export async function countRecentPurchases(
  env: Env,
  tenantId: string,
  productId: string,
  sinceMs: number,
): Promise<number> {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM behavior_events
        WHERE tenant_id = ? AND product_id = ? AND type = 'purchase' AND ts >= ?`,
    )
      .bind(tenantId, productId, sinceMs)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export interface AbandonedCandidate {
  tenant_id: string;
  thread_id: string;
  customer_id: string;
  last_ts: number;
}

/**
 * Global (cross-tenant) scan for carts with purchase intent but no completed
 * purchase, idle past `idleBefore`, within the `lookbackFrom` window. Used by
 * the abandoned-cart cron — mirrors the anomaly detector's global query style.
 */
export async function findAbandonedCandidates(
  env: Env,
  opts: { lookbackFrom: number; idleBefore: number; limit: number },
): Promise<AbandonedCandidate[]> {
  const rows = await env.DB.prepare(
    `SELECT tenant_id, thread_id,
            MAX(ts) AS last_ts,
            MAX(customer_id) AS customer_id,
            MAX(CASE WHEN type IN ('add_to_cart','checkout_start') THEN 1 ELSE 0 END) AS has_intent,
            MAX(CASE WHEN type = 'purchase' THEN 1 ELSE 0 END) AS has_purchase
       FROM behavior_events
      WHERE thread_id != '' AND ts >= ?
      GROUP BY tenant_id, thread_id
     HAVING has_intent = 1 AND has_purchase = 0 AND last_ts <= ?
      LIMIT ?`,
  )
    .bind(opts.lookbackFrom, opts.idleBefore, opts.limit)
    .all<{
      tenant_id: string;
      thread_id: string;
      last_ts: number;
      customer_id: string;
    }>();
  return (rows.results ?? []).map((r) => ({
    tenant_id: r.tenant_id,
    thread_id: r.thread_id,
    customer_id: r.customer_id ?? '',
    last_ts: r.last_ts,
  }));
}

/**
 * Record a detected abandoned cart. Returns true only when newly inserted, so
 * the cron emits a recovery signal exactly once per idle cart.
 */
export async function markAbandoned(
  env: Env,
  candidate: AbandonedCandidate,
  nowMs: number,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT INTO abandoned_carts (tenant_id, thread_id, customer_id, detected_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (tenant_id, thread_id) DO NOTHING`,
  )
    .bind(candidate.tenant_id, candidate.thread_id, candidate.customer_id, nowMs)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
