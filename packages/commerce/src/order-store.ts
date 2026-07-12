/**
 * Order store (Postgres). Orders are written when a Stripe Checkout Session
 * completes (the webhook converts the session cart into an order). Every
 * query is scoped by tenant_id — composite (tenant_id, id) primary keys.
 */

import { getDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';
import { type Order, OrderSchema, type OrderStatus } from './models';

interface OrderRow {
  tenant_id: string;
  id: string;
  thread_id: string;
  stripe_ref: string;
  total_cents: number;
  currency: string;
  status: string;
  created_at: number;
}

interface OrderItemRow {
  product_id: string;
  title: string;
  qty: number;
  price_cents: number;
}

export async function createOrder(env: Env, order: Order): Promise<void> {
  const sql = getDb(env);
  const itemRows = order.items.map((it) => ({
    tenant_id: order.tenant_id,
    order_id: order.id,
    product_id: it.product_id,
    title: it.title,
    qty: it.qty,
    price_cents: it.price_cents,
  }));
  // Order header + items land in one transaction so a reader never sees a
  // header without its items (an upgrade over the D1 batch this replaced).
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO orders (tenant_id, id, thread_id, stripe_ref, total_cents, currency,
                          status, created_at)
        VALUES (${order.tenant_id}, ${order.id}, ${order.thread_id}, ${order.stripe_ref},
                ${order.total_cents}, ${order.currency}, ${order.status}, ${order.created_at})
        ON CONFLICT (tenant_id, id) DO NOTHING
    `;
    if (itemRows.length > 0) {
      await tx`
        INSERT INTO order_items ${tx(itemRows)}
          ON CONFLICT (tenant_id, order_id, product_id) DO NOTHING
      `;
    }
  });
}

export async function getOrder(env: Env, tenantId: string, id: string): Promise<Order | null> {
  const sql = getDb(env);
  const rows = await sql<OrderRow[]>`
    SELECT * FROM orders WHERE tenant_id = ${tenantId} AND id = ${id} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const items = await sql<OrderItemRow[]>`
    SELECT product_id, title, qty, price_cents FROM order_items
      WHERE tenant_id = ${tenantId} AND order_id = ${id}
  `;
  return OrderSchema.parse({
    tenant_id: row.tenant_id,
    id: row.id,
    thread_id: row.thread_id,
    stripe_ref: row.stripe_ref,
    total_cents: row.total_cents,
    currency: row.currency,
    status: row.status,
    created_at: row.created_at,
    items: [...items],
  });
}

export async function setOrderStatus(
  env: Env,
  tenantId: string,
  id: string,
  status: OrderStatus,
): Promise<void> {
  const sql = getDb(env);
  await sql`
    UPDATE orders SET status = ${status} WHERE tenant_id = ${tenantId} AND id = ${id}
  `;
}
