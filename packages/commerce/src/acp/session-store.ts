/**
 * ACP checkout-session store (Postgres). The full CheckoutSession object is
 * stored as jsonb; `status` and `order_id` are promoted to columns. Scoped by
 * the merchant tenant — composite (tenant_id, id) primary key.
 */

import { getDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';
import type { AcpCheckoutSession } from './models';

interface SessionRow {
  session_json: AcpCheckoutSession;
  order_id: string;
}

export async function putSession(
  env: Env,
  tenantId: string,
  session: AcpCheckoutSession,
  nowMs: number,
  orderId = '',
): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO acp_checkout_sessions (tenant_id, id, status, session_json, order_id, created_at, updated_at)
      VALUES (${tenantId}, ${session.id}, ${session.status},
              ${session as unknown as Record<string, unknown>}, ${orderId}, ${nowMs}, ${nowMs})
      ON CONFLICT (tenant_id, id) DO UPDATE SET
        status = excluded.status,
        session_json = excluded.session_json,
        order_id = CASE WHEN excluded.order_id != '' THEN excluded.order_id ELSE acp_checkout_sessions.order_id END,
        updated_at = excluded.updated_at
  `;
}

export async function getSession(
  env: Env,
  tenantId: string,
  id: string,
): Promise<{ session: AcpCheckoutSession; orderId: string } | null> {
  const sql = getDb(env);
  const rows = await sql<SessionRow[]>`
    SELECT session_json, order_id FROM acp_checkout_sessions
      WHERE tenant_id = ${tenantId} AND id = ${id} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { session: row.session_json, orderId: row.order_id };
}
