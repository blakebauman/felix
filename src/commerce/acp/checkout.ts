/**
 * ACP checkout session construction.
 *
 * Builds a CheckoutSession from `items` against our D1 catalog: resolves each
 * item to a product, computes line items + totals (integer cents), offers
 * fulfillment options, and derives the protocol status. All pricing is
 * server-side — the agent's job is to collect buyer/address/payment, never to
 * assert amounts.
 *
 * Shipping options come from the configurable shipping seam; tax from the tax
 * seam (a flat configurable rate in v1, 0 by default). Both are swappable for
 * real providers without changing this builder.
 */

import type { Env } from '../../env';
import { decrementInventory, getProduct } from '../catalog-store';
import type { Order } from '../models';
import { createOrder, getOrder } from '../order-store';
import { shippingOptions } from '../shipping';
import { computeTax } from '../tax';
import type {
  AcpAddress,
  AcpBuyer,
  AcpCheckoutSession,
  AcpFulfillmentOption,
  AcpItem,
  AcpLineItem,
  AcpMessage,
  AcpOrder,
  AcpStatus,
  AcpTotal,
} from './models';

const ORDER_PERMALINK_BASE =
  // Where a human can view the order after purchase.
  'https://shop.felix.run/orders';

function isoPlusDays(nowMs: number, days: number): string {
  return new Date(nowMs + days * 86_400_000).toISOString();
}

/** Resolve configured shipping options into ACP fulfillment options. */
async function fulfillmentOptions(
  env: Env,
  subtotalCents: number,
  nowMs: number,
): Promise<AcpFulfillmentOption[]> {
  return (await shippingOptions(env, { subtotalCents })).map((o) => ({
    type: 'shipping',
    id: o.id,
    title: o.title,
    subtitle: o.subtitle,
    carrier: o.carrier,
    earliest_delivery_time: isoPlusDays(nowMs, o.min_days),
    latest_delivery_time: isoPlusDays(nowMs, o.max_days),
    subtotal: o.amount_cents,
    tax: 0,
    total: o.amount_cents,
  }));
}

export interface BuildInput {
  id: string;
  items: AcpItem[];
  buyer?: AcpBuyer;
  fulfillment_address?: AcpAddress;
  fulfillment_option_id?: string;
  nowMs: number;
}

/**
 * Resolve items against the catalog and assemble the full session. Pure apart
 * from the catalog reads — does not persist.
 */
export async function buildSession(
  env: Env,
  tenantId: string,
  input: BuildInput,
): Promise<AcpCheckoutSession> {
  const messages: AcpMessage[] = [];
  const lineItems: AcpLineItem[] = [];
  let currency = 'usd';

  for (let i = 0; i < input.items.length; i += 1) {
    const it = input.items[i]!;
    const product = await getProduct(env, tenantId, it.id);
    if (!product) {
      messages.push({
        type: 'error',
        code: 'invalid',
        param: `$.items[${i}].id`,
        content_type: 'plain',
        content: `Unknown product '${it.id}'.`,
      });
      continue;
    }
    if (product.inventory === 0) {
      messages.push({
        type: 'error',
        code: 'out_of_stock',
        param: `$.items[${i}].id`,
        content_type: 'plain',
        content: `'${product.title}' is out of stock.`,
      });
      continue;
    }
    currency = product.currency;
    const base = product.price_cents * it.quantity;
    lineItems.push({
      id: `li_${product.id}`,
      item: { id: product.id, quantity: it.quantity },
      base_amount: base,
      discount: 0,
      subtotal: base,
      tax: 0,
      total: base,
    });
  }

  const hasErrors = messages.some((m) => m.type === 'error');
  const itemsBase = lineItems.reduce((s, li) => s + li.base_amount, 0);
  const subtotal = lineItems.reduce((s, li) => s + li.subtotal, 0);

  // Shipping options depend on the subtotal (free-shipping threshold).
  const options = input.fulfillment_address
    ? await fulfillmentOptions(env, subtotal, input.nowMs)
    : [];

  // Auto-select the first option when an address is present and none chosen.
  let selectedId = input.fulfillment_option_id;
  if (input.fulfillment_address && !selectedId && options.length) selectedId = options[0]!.id;
  const selected = options.find((o) => o.id === selectedId);

  if (!input.fulfillment_address && !hasErrors) {
    messages.push({
      type: 'info',
      content_type: 'plain',
      content: 'Add a shipping address to see delivery options and continue.',
    });
  }

  const fulfillment = selected?.total ?? 0;
  const tax = computeTax(env, {
    subtotalCents: subtotal,
    shippingCents: fulfillment,
    address: input.fulfillment_address,
  });
  const total = subtotal + fulfillment + tax;

  const totals: AcpTotal[] = [
    { type: 'items_base_amount', display_text: 'Items', amount: itemsBase },
    { type: 'subtotal', display_text: 'Subtotal', amount: subtotal },
    { type: 'fulfillment', display_text: 'Shipping', amount: fulfillment },
    { type: 'tax', display_text: 'Tax', amount: tax },
    { type: 'total', display_text: 'Total', amount: total },
  ];

  const status: AcpStatus =
    hasErrors || lineItems.length === 0
      ? 'not_ready_for_payment'
      : input.fulfillment_address && selected
        ? 'ready_for_payment'
        : 'not_ready_for_payment';

  return {
    id: input.id,
    ...(input.buyer ? { buyer: input.buyer } : {}),
    payment_provider: { provider: 'stripe', supported_payment_methods: ['card'] },
    status,
    currency,
    line_items: lineItems,
    ...(input.fulfillment_address ? { fulfillment_address: input.fulfillment_address } : {}),
    fulfillment_options: options,
    ...(selected ? { fulfillment_option_id: selected.id } : {}),
    totals,
    messages,
    links: [
      { type: 'terms_of_use', url: 'https://shop.felix.run/terms' },
      { type: 'privacy_policy', url: 'https://shop.felix.run/privacy' },
    ],
  };
}

/** Sum of the `total` total — the authoritative amount to charge. */
export function sessionTotal(session: AcpCheckoutSession): number {
  return session.totals.find((t) => t.type === 'total')?.amount ?? 0;
}

/**
 * Persist a paid order from a completed session + the settled payment ref.
 * Returns the ACP `order` object to echo back on the session.
 */
export async function finalizeOrder(
  env: Env,
  tenantId: string,
  session: AcpCheckoutSession,
  paymentRef: string,
  nowMs: number,
): Promise<AcpOrder> {
  // Deterministic per-session order id so a retried/concurrent `complete`
  // (which already reuses the same Stripe PaymentIntent via the idempotency
  // key) does not create a duplicate order or double-decrement inventory.
  const orderId = `acp_order_${session.id}`;
  const existing = await getOrder(env, tenantId, orderId);
  if (existing) {
    return {
      id: orderId,
      checkout_session_id: session.id,
      permalink_url: `${ORDER_PERMALINK_BASE}/${orderId}`,
    };
  }
  const order: Order = {
    tenant_id: tenantId,
    id: orderId,
    thread_id: '',
    stripe_ref: paymentRef,
    total_cents: sessionTotal(session),
    currency: session.currency,
    status: 'paid',
    created_at: nowMs,
    items: session.line_items.map((li) => ({
      product_id: li.item.id,
      title: '',
      qty: li.item.quantity,
      price_cents: li.base_amount,
    })),
  };
  await createOrder(env, order);
  await decrementInventory(
    env,
    tenantId,
    order.items.map((it) => ({ id: it.product_id, qty: it.qty })),
  );
  return {
    id: orderId,
    checkout_session_id: session.id,
    permalink_url: `${ORDER_PERMALINK_BASE}/${orderId}`,
  };
}
