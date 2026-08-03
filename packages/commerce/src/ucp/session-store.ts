/**
 * UCP checkout-session store (Postgres). The full CheckoutSession object is
 * stored as jsonb; `status` and `order_id` are promoted to columns. Scoped by
 * the merchant tenant — composite (tenant_id, id) primary key. Mirrors the ACP
 * store over its own `ucp_checkout_sessions` table so the two protocols'
 * status enums and lifecycles never mix.
 */

import { getDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';
import type { UcpCheckoutSession } from './models';

interface SessionRow {
  session_json: UcpCheckoutSession;
  order_id: string;
}

export async function putUcpSession(
  env: Env,
  tenantId: string,
  session: UcpCheckoutSession,
  nowMs: number,
  orderId = '',
): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO ucp_checkout_sessions (tenant_id, id, status, session_json, order_id, created_at, updated_at)
      VALUES (${tenantId}, ${session.id}, ${session.status},
              ${session as unknown as Record<string, unknown>}, ${orderId}, ${nowMs}, ${nowMs})
      ON CONFLICT (tenant_id, id) DO UPDATE SET
        status = excluded.status,
        session_json = excluded.session_json,
        order_id = CASE WHEN excluded.order_id != '' THEN excluded.order_id ELSE ucp_checkout_sessions.order_id END,
        updated_at = excluded.updated_at
  `;
}

export async function getUcpSession(
  env: Env,
  tenantId: string,
  id: string,
): Promise<{ session: UcpCheckoutSession; orderId: string } | null> {
  const sql = getDb(env);
  const rows = await sql<SessionRow[]>`
    SELECT session_json, order_id FROM ucp_checkout_sessions
      WHERE tenant_id = ${tenantId} AND id = ${id} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { session: row.session_json, orderId: row.order_id };
}
