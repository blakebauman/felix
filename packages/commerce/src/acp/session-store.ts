/**
 * ACP checkout-session store (D1). The full CheckoutSession object is stored
 * as JSON; `status` and `order_id` are promoted to columns. Scoped by the
 * merchant tenant — composite (tenant_id, id) primary key.
 */

import type { Env } from '@felix/orchestrator/env';
import type { AcpCheckoutSession } from './models';

interface SessionRow {
  session_json: string;
  order_id: string;
}

export async function putSession(
  env: Env,
  tenantId: string,
  session: AcpCheckoutSession,
  nowMs: number,
  orderId = '',
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO acp_checkout_sessions (tenant_id, id, status, session_json, order_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       status = excluded.status,
       session_json = excluded.session_json,
       order_id = CASE WHEN excluded.order_id != '' THEN excluded.order_id ELSE acp_checkout_sessions.order_id END,
       updated_at = excluded.updated_at`,
  )
    .bind(tenantId, session.id, session.status, JSON.stringify(session), orderId, nowMs, nowMs)
    .run();
}

export async function getSession(
  env: Env,
  tenantId: string,
  id: string,
): Promise<{ session: AcpCheckoutSession; orderId: string } | null> {
  const row = await env.DB.prepare(
    'SELECT session_json, order_id FROM acp_checkout_sessions WHERE tenant_id = ? AND id = ? LIMIT 1',
  )
    .bind(tenantId, id)
    .first<SessionRow>();
  if (!row) return null;
  return { session: JSON.parse(row.session_json) as AcpCheckoutSession, orderId: row.order_id };
}
