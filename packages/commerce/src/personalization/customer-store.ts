/**
 * Customer + behavior-event store (Postgres). Every query is tenant-scoped via
 * the composite (tenant_id, id) primary key, matching the rest of the schema.
 *
 * Behavior recording is best-effort telemetry — `recordBehaviorEvent` never
 * throws into a caller; it logs and returns. Recommendation seeding and
 * abandoned-cart detection both read back through this store.
 */

import { getDb } from '@felix/harness/db/client';
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
  attrs_json: Record<string, unknown> | null;
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
  metadata_json: Record<string, unknown> | null;
}

function rowToCustomer(row: CustomerRow): Customer {
  return CustomerSchema.parse({
    tenant_id: row.tenant_id,
    id: row.id,
    email: row.email,
    external_ref: row.external_ref,
    attrs: row.attrs_json ?? {},
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
    metadata: row.metadata_json ?? {},
  });
}

export async function upsertCustomer(env: Env, customer: Customer): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO customers (tenant_id, id, email, external_ref, attrs_json, created_at, last_seen_at)
      VALUES (${customer.tenant_id}, ${customer.id}, ${customer.email}, ${customer.external_ref},
              ${customer.attrs as Record<string, unknown>}, ${customer.created_at},
              ${customer.last_seen_at})
      ON CONFLICT (tenant_id, id) DO UPDATE SET
        email = excluded.email,
        external_ref = excluded.external_ref,
        attrs_json = excluded.attrs_json,
        last_seen_at = excluded.last_seen_at
  `;
}

export async function getCustomer(
  env: Env,
  tenantId: string,
  id: string,
): Promise<Customer | null> {
  const sql = getDb(env);
  const rows = await sql<CustomerRow[]>`
    SELECT * FROM customers WHERE tenant_id = ${tenantId} AND id = ${id} LIMIT 1
  `;
  return rows[0] ? rowToCustomer(rows[0]) : null;
}

/** Link a conversation thread to a customer (cross-session identity). */
export async function linkSessionToCustomer(
  env: Env,
  tenantId: string,
  threadId: string,
  customerId: string,
  nowMs: number,
): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO customer_sessions (tenant_id, thread_id, customer_id, created_at)
      VALUES (${tenantId}, ${threadId}, ${customerId}, ${nowMs})
      ON CONFLICT (tenant_id, thread_id) DO UPDATE SET customer_id = excluded.customer_id
  `;
}

/** Resolve the customer id linked to a thread, if any. */
export async function getSessionCustomer(
  env: Env,
  tenantId: string,
  threadId: string,
): Promise<string | null> {
  if (!threadId) return null;
  const sql = getDb(env);
  const rows = await sql<{ customer_id: string }[]>`
    SELECT customer_id FROM customer_sessions
      WHERE tenant_id = ${tenantId} AND thread_id = ${threadId} LIMIT 1
  `;
  return rows[0]?.customer_id ?? null;
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
    const sql = getDb(env);
    await sql`
      UPDATE behavior_events SET customer_id = ${customerId}
        WHERE tenant_id = ${tenantId} AND thread_id = ${threadId} AND customer_id = ''
    `;
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
    const sql = getDb(env);
    await sql`
      INSERT INTO behavior_events
          (tenant_id, id, customer_id, thread_id, type, product_id, ts, metadata_json)
        VALUES (${evt.tenant_id}, ${crypto.randomUUID()}, ${evt.customer_id ?? ''},
                ${evt.thread_id ?? ''}, ${evt.type}, ${evt.product_id ?? ''}, ${evt.ts},
                ${evt.metadata ?? {}})
    `;
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
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const sql = getDb(env);
  const rows = await sql<BehaviorRow[]>`
    SELECT * FROM behavior_events
      WHERE tenant_id = ${tenantId}
      ${
        opts.customerId
          ? sql`AND customer_id = ${opts.customerId}`
          : opts.threadId
            ? sql`AND thread_id = ${opts.threadId}`
            : sql``
      }
      ${opts.types?.length ? sql`AND type IN ${sql(opts.types)}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
  `;
  return rows.map(rowToEvent);
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
    const sql = getDb(env);
    const rows = await sql<{ n: number }[]>`
      SELECT COUNT(*) AS n FROM behavior_events
        WHERE tenant_id = ${tenantId} AND product_id = ${productId}
          AND type = 'purchase' AND ts >= ${sinceMs}
    `;
    return Number(rows[0]?.n ?? 0);
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
  const sql = getDb(env);
  // Postgres HAVING can't reference SELECT aliases (SQLite could), so the
  // intent/purchase aggregates move into HAVING as bool_or predicates.
  const rows = await sql<
    { tenant_id: string; thread_id: string; last_ts: number; customer_id: string | null }[]
  >`
    SELECT tenant_id, thread_id,
            MAX(ts) AS last_ts,
            MAX(customer_id) AS customer_id
       FROM behavior_events
      WHERE thread_id != '' AND ts >= ${opts.lookbackFrom}
      GROUP BY tenant_id, thread_id
     HAVING bool_or(type IN ('add_to_cart', 'checkout_start'))
        AND NOT bool_or(type = 'purchase')
        AND MAX(ts) <= ${opts.idleBefore}
      LIMIT ${opts.limit}
  `;
  return rows.map((r) => ({
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
  const sql = getDb(env);
  const res = await sql`
    INSERT INTO abandoned_carts (tenant_id, thread_id, customer_id, detected_at)
      VALUES (${candidate.tenant_id}, ${candidate.thread_id}, ${candidate.customer_id}, ${nowMs})
      ON CONFLICT (tenant_id, thread_id) DO NOTHING
  `;
  return res.count > 0;
}
