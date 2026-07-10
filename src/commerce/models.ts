/**
 * Commerce domain models (Zod).
 *
 * `Product` mirrors the `products` D1 table; `Order` / `OrderItem` mirror
 * `orders` / `order_items`. `Cart` / `CartItem` have no table — the cart is
 * stored as a session event payload (see `cart-session.ts`).
 *
 * Money is integer cents throughout. Never round in floating point.
 */

import { z } from '@hono/zod-openapi';

export const ProductSchema = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: z.string().min(1).openapi({ description: 'SKU / product id.', example: 'tee-001' }),
    title: z.string().min(1).openapi({ example: 'Classic Tee' }),
    description: z.string().default(''),
    price_cents: z.number().int().nonnegative().openapi({ example: 2500 }),
    currency: z.string().default('usd'),
    image_url: z.string().default(''),
    category: z.string().default(''),
    inventory: z
      .number()
      .int()
      .default(0)
      .openapi({ description: 'Units in stock; -1 means unlimited.' }),
    active: z.boolean().default(true),
    attrs: z.record(z.string(), z.unknown()).default({}),
    created_at: z.number().int(),
  })
  .strict()
  .openapi('Product');

export type Product = z.infer<typeof ProductSchema>;

export const CartItemSchema = z
  .object({
    product_id: z.string().min(1),
    title: z.string().default(''),
    qty: z.number().int().positive(),
    price_cents: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('CartItem');

export type CartItem = z.infer<typeof CartItemSchema>;

export const CartSchema = z
  .object({
    items: z.array(CartItemSchema).default([]),
    currency: z.string().default('usd'),
    updated_at: z.number().int().default(0),
  })
  .strict()
  .openapi('Cart');

export type Cart = z.infer<typeof CartSchema>;

export const OrderItemSchema = z
  .object({
    product_id: z.string().min(1),
    title: z.string().default(''),
    qty: z.number().int().positive(),
    price_cents: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('OrderItem');

export type OrderItem = z.infer<typeof OrderItemSchema>;

export const OrderStatus = z.enum(['pending', 'paid', 'fulfilled', 'cancelled']);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const OrderSchema = z
  .object({
    tenant_id: z.string().min(1).default('default'),
    id: z.string().min(1),
    thread_id: z.string().default(''),
    stripe_ref: z.string().default(''),
    total_cents: z.number().int().nonnegative(),
    currency: z.string().default('usd'),
    status: OrderStatus.default('pending'),
    created_at: z.number().int(),
    items: z.array(OrderItemSchema).default([]),
  })
  .strict()
  .openapi('Order');

export type Order = z.infer<typeof OrderSchema>;

/** Server-side cart total in cents. Never trust the model's arithmetic. */
export function cartTotalCents(items: ReadonlyArray<CartItem>): number {
  return items.reduce((sum, it) => sum + it.price_cents * it.qty, 0);
}
