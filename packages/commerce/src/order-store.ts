/**
 * Order store (D1). Orders are written when a Stripe Checkout Session
 * completes (the webhook converts the session cart into an order). Every
 * query is scoped by tenant_id — composite (tenant_id, id) primary keys.
 */

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
  const stmts = [
    env.DB.prepare(
      `INSERT INTO orders (tenant_id, id, thread_id, stripe_ref, total_cents, currency,
                           status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, id) DO NOTHING`,
    ).bind(
      order.tenant_id,
      order.id,
      order.thread_id,
      order.stripe_ref,
      order.total_cents,
      order.currency,
      order.status,
      order.created_at,
    ),
    ...order.items.map((it) =>
      env.DB.prepare(
        `INSERT INTO order_items (tenant_id, order_id, product_id, title, qty, price_cents)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, order_id, product_id) DO NOTHING`,
      ).bind(order.tenant_id, order.id, it.product_id, it.title, it.qty, it.price_cents),
    ),
  ];
  await env.DB.batch(stmts);
}

export async function getOrder(env: Env, tenantId: string, id: string): Promise<Order | null> {
  const row = await env.DB.prepare('SELECT * FROM orders WHERE tenant_id = ? AND id = ? LIMIT 1')
    .bind(tenantId, id)
    .first<OrderRow>();
  if (!row) return null;
  const items = await env.DB.prepare(
    'SELECT product_id, title, qty, price_cents FROM order_items WHERE tenant_id = ? AND order_id = ?',
  )
    .bind(tenantId, id)
    .all<OrderItemRow>();
  return OrderSchema.parse({
    tenant_id: row.tenant_id,
    id: row.id,
    thread_id: row.thread_id,
    stripe_ref: row.stripe_ref,
    total_cents: row.total_cents,
    currency: row.currency,
    status: row.status,
    created_at: row.created_at,
    items: items.results ?? [],
  });
}

export async function setOrderStatus(
  env: Env,
  tenantId: string,
  id: string,
  status: OrderStatus,
): Promise<void> {
  await env.DB.prepare('UPDATE orders SET status = ? WHERE tenant_id = ? AND id = ?')
    .bind(status, tenantId, id)
    .run();
}
