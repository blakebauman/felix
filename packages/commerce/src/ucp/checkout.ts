/**
 * UCP checkout session construction.
 *
 * Sibling of `../acp/checkout.ts` over the same protocol-neutral seams
 * (catalog-store, shipping, tax, order-store): resolves each line item against
 * the catalog, computes line + session totals (integer cents, enforcing the
 * UCP invariant Σ non-total == total), quotes shipping options into the
 * fulfillment extension's method/group shape, and derives the protocol status.
 * All pricing is server-side — the platform's job is to collect buyer/
 * destination/payment, never to assert amounts.
 */

import type { Env } from '@felix/harness/env';
import type { AcpAddress } from '../acp/models';
import { decrementInventory, getProduct } from '../catalog-store';
import type { Order } from '../models';
import { createOrder, getOrder } from '../order-store';
import { shippingOptions } from '../shipping';
import { computeTax } from '../tax';
import {
  UCP_VERSION,
  type UcpBuyer,
  type UcpCheckoutSession,
  type UcpDestination,
  type UcpDestinationInput,
  type UcpFulfillmentOption,
  type UcpLineItem,
  type UcpMessage,
  type UcpPaymentHandler,
  type UcpStatus,
  type UcpTotal,
  ucpEnvelope,
} from './models';

const ORDER_PERMALINK_BASE =
  // Where a human can view the order after purchase.
  'https://shop.felix.run/orders';

/** Session TTL per spec default (6 hours) when the merchant sets none. */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function isoPlusDays(nowMs: number, days: number): string {
  return new Date(nowMs + days * 86_400_000).toISOString();
}

/** The single payment handler this merchant advertises: gateway tokens settled
 * by our own PSP (Stripe). Instrument tokens must be Stripe-chargeable. */
export function stripePaymentHandler(): UcpPaymentHandler {
  return {
    id: 'stripe',
    name: 'com.stripe',
    version: UCP_VERSION,
    spec: 'https://docs.stripe.com/agentic-commerce',
    config_schema: 'https://ucp.dev/schemas/payment_handler.json',
    instrument_schemas: [
      `https://ucp.dev/${UCP_VERSION}/schemas/shopping/types/card_payment_instrument.json`,
    ],
    config: {},
  };
}

/** Flatten a destination input (flat fields or nested `address`) into the
 * response destination, assigning an id when the platform sent none. */
export function normalizeDestination(input: UcpDestinationInput, index: number): UcpDestination {
  const { address, id, name, ...flat } = input;
  return {
    ...flat,
    ...(address ?? {}),
    id: id || `dest_${index + 1}`,
    ...(name ? { name } : {}),
  };
}

/** Map a UCP destination to the tax seam's address shape. */
function taxAddress(dest: UcpDestination | undefined): AcpAddress | undefined {
  if (!dest) return undefined;
  return {
    name: dest.full_name ?? '',
    line_one: dest.street_address ?? '',
    city: dest.address_locality ?? '',
    state: dest.address_region ?? '',
    country: dest.address_country ?? '',
    postal_code: dest.postal_code ?? '',
  };
}

/** Resolve configured shipping options into UCP fulfillment options. */
async function fulfillmentOptions(
  env: Env,
  subtotalCents: number,
  nowMs: number,
): Promise<UcpFulfillmentOption[]> {
  return (await shippingOptions(env, { subtotalCents })).map((o) => ({
    id: o.id,
    title: o.title,
    description: o.subtitle,
    carrier: o.carrier,
    earliest_fulfillment_time: isoPlusDays(nowMs, o.min_days),
    latest_fulfillment_time: isoPlusDays(nowMs, o.max_days),
    subtotal: o.amount_cents,
    tax: 0,
    total: o.amount_cents,
  }));
}

export interface UcpBuildInput {
  id: string;
  items: Array<{ itemId: string; quantity: number; lineId?: string }>;
  buyer?: UcpBuyer;
  destination?: UcpDestination;
  selectedOptionId?: string | null;
  nowMs: number;
}

/**
 * Resolve items against the catalog and assemble the full session. Pure apart
 * from the catalog reads — does not persist.
 */
export async function buildUcpSession(
  env: Env,
  tenantId: string,
  input: UcpBuildInput,
): Promise<UcpCheckoutSession> {
  const messages: UcpMessage[] = [];
  const lineItems: UcpLineItem[] = [];
  let currency = 'usd';

  for (let i = 0; i < input.items.length; i += 1) {
    const it = input.items[i]!;
    const product = await getProduct(env, tenantId, it.itemId);
    if (!product) {
      messages.push({
        type: 'error',
        code: 'invalid',
        severity: 'recoverable',
        path: `$.line_items[${i}].item.id`,
        content_type: 'plain',
        content: `Unknown product '${it.itemId}'.`,
      });
      continue;
    }
    if (product.inventory === 0) {
      messages.push({
        type: 'error',
        code: 'out_of_stock',
        severity: 'recoverable',
        path: `$.line_items[${i}].item.id`,
        content_type: 'plain',
        content: `'${product.title}' is out of stock.`,
      });
      continue;
    }
    currency = product.currency;
    const lineTotal = product.price_cents * it.quantity;
    lineItems.push({
      id: it.lineId || `line_${product.id}`,
      item: {
        id: product.id,
        title: product.title,
        price: product.price_cents,
        ...(product.image_url ? { image_url: product.image_url } : {}),
      },
      quantity: it.quantity,
      totals: [
        { type: 'subtotal', amount: lineTotal },
        { type: 'total', amount: lineTotal },
      ],
    });
  }

  const hasErrors = messages.some((m) => m.type === 'error');
  const subtotal = lineItems.reduce(
    (s, li) => s + (li.totals.find((t) => t.type === 'subtotal')?.amount ?? 0),
    0,
  );

  // Shipping options depend on the subtotal (free-shipping threshold) and
  // only exist once the platform supplied a destination.
  const options = input.destination ? await fulfillmentOptions(env, subtotal, input.nowMs) : [];

  // Auto-select the first option when a destination is present and none chosen.
  let selectedId = input.selectedOptionId ?? undefined;
  if (input.destination && !selectedId && options.length) selectedId = options[0]!.id;
  const selected = options.find((o) => o.id === selectedId);

  if (!input.destination && !hasErrors) {
    messages.push({
      type: 'info',
      content_type: 'plain',
      content: 'Add a shipping destination to see delivery options and continue.',
    });
  }

  const fulfillmentCents = selected?.total ?? 0;
  const tax = computeTax(env, {
    subtotalCents: subtotal,
    shippingCents: fulfillmentCents,
    address: taxAddress(input.destination),
  });
  const total = subtotal + fulfillmentCents + tax;

  // UCP invariant: exactly one subtotal + one total; Σ non-total == total.
  const totals: UcpTotal[] = [
    { type: 'subtotal', amount: subtotal, display_text: 'Subtotal' },
    ...(fulfillmentCents > 0
      ? [
          {
            type: 'fulfillment',
            amount: fulfillmentCents,
            display_text: selected?.title,
          } as UcpTotal,
        ]
      : []),
    ...(tax > 0 ? [{ type: 'tax', amount: tax, display_text: 'Tax' } as UcpTotal] : []),
    { type: 'total', amount: total, display_text: 'Total' },
  ];

  const status: UcpStatus =
    hasErrors || lineItems.length === 0
      ? 'incomplete'
      : input.destination && selected
        ? 'ready_for_complete'
        : 'incomplete';

  const lineItemIds = lineItems.map((li) => li.id);

  return {
    id: input.id,
    status,
    currency,
    ...(input.buyer ? { buyer: input.buyer } : {}),
    line_items: lineItems,
    fulfillment: {
      methods: [
        {
          id: 'method_shipping',
          type: 'shipping',
          line_item_ids: lineItemIds,
          ...(input.destination
            ? {
                destinations: [input.destination],
                selected_destination_id: input.destination.id,
              }
            : {}),
          groups: [
            {
              id: 'group_1',
              line_item_ids: lineItemIds,
              options,
              ...(selected ? { selected_option_id: selected.id } : {}),
            },
          ],
        },
      ],
    },
    payment: { handlers: [stripePaymentHandler()] },
    totals,
    messages,
    links: [
      { type: 'terms_of_service', url: 'https://shop.felix.run/terms' },
      { type: 'privacy_policy', url: 'https://shop.felix.run/privacy' },
    ],
    expires_at: new Date(input.nowMs + SESSION_TTL_MS).toISOString(),
    ucp: ucpEnvelope(),
  };
}

/** The `total` total — the authoritative amount to charge. */
export function ucpSessionTotal(session: UcpCheckoutSession): number {
  return session.totals.find((t) => t.type === 'total')?.amount ?? 0;
}

/** Reconstruct builder inputs from a stored session (for update/complete rebuilds). */
export function inputsFromSession(
  session: UcpCheckoutSession,
): Omit<UcpBuildInput, 'id' | 'nowMs'> {
  const method = session.fulfillment?.methods?.find((m) => m.type === 'shipping');
  const destination = method?.destinations?.find((d) => d.id === method.selected_destination_id);
  const group = method?.groups?.[0];
  return {
    items: session.line_items.map((li) => ({
      itemId: li.item.id,
      quantity: li.quantity,
      lineId: li.id,
    })),
    buyer: session.buyer,
    destination,
    selectedOptionId: group?.selected_option_id ?? undefined,
  };
}

/**
 * Persist a paid order from a completed session + the settled payment ref.
 * Returns the order fields to stamp onto the session. Idempotent per session:
 * the deterministic order id means a retried/concurrent `complete` (which
 * already reuses the same Stripe PaymentIntent via the idempotency key) does
 * not create a duplicate order or double-decrement inventory.
 */
export async function finalizeUcpOrder(
  env: Env,
  tenantId: string,
  session: UcpCheckoutSession,
  paymentRef: string,
  nowMs: number,
): Promise<{ order_id: string; order_permalink_url: string }> {
  const orderId = `ucp_order_${session.id}`;
  const permalink = `${ORDER_PERMALINK_BASE}/${orderId}`;
  const existing = await getOrder(env, tenantId, orderId);
  if (existing) return { order_id: orderId, order_permalink_url: permalink };

  const order: Order = {
    tenant_id: tenantId,
    id: orderId,
    thread_id: '',
    stripe_ref: paymentRef,
    total_cents: ucpSessionTotal(session),
    currency: session.currency,
    status: 'paid',
    created_at: nowMs,
    items: session.line_items.map((li) => ({
      product_id: li.item.id,
      title: li.item.title,
      qty: li.quantity,
      price_cents: li.item.price * li.quantity,
    })),
  };
  await createOrder(env, order);
  await decrementInventory(
    env,
    tenantId,
    order.items.map((it) => ({ id: it.product_id, qty: it.qty })),
  );
  return { order_id: orderId, order_permalink_url: permalink };
}
