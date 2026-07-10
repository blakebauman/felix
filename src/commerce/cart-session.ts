/**
 * Session-backed cart.
 *
 * The cart is NOT a D1 table — it lives in the append-only session log as a
 * `kind: 'audit'` event with `metadata: { type: 'cart', pinned: true }` and a
 * `Cart` JSON payload on `content`. Each mutation appends a fresh snapshot;
 * the highest-`seq` cart event wins (no delta folding). Audit-kind events are
 * bookkeeping — the render strategies skip them, so the cart never pollutes the
 * message window; the model reads it on demand via the `cart_view` tool.
 *
 * Reads/writes go through `getSessionStore(env, 'do')` keyed by threadId — the
 * same ConversationDO the react loop persists conversation turns to.
 */

import type { Env } from '../env';
import { getSessionStore } from '../session/do-session';
import type { Session } from '../session/types';
import { type Cart, type CartItem, CartSchema } from './models';

const CART_META_TYPE = 'cart';

function openSession(env: Env, threadId: string): Session {
  return getSessionStore(env, 'do').open(threadId);
}

function emptyCart(): Cart {
  return { items: [], currency: 'usd', updated_at: 0 };
}

/** Read the latest cart snapshot from the session, or an empty cart. */
export async function readCart(env: Env, threadId: string): Promise<Cart> {
  if (!threadId) return emptyCart();
  const session = openSession(env, threadId);
  const events = await session.getEvents({ kinds: ['audit'] });
  // Highest seq wins — getEvents returns ascending seq, so scan from the end.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.metadata?.type === CART_META_TYPE && e.content) {
      const parsed = CartSchema.safeParse(JSON.parse(e.content));
      if (parsed.success) return parsed.data;
    }
  }
  return emptyCart();
}

/** Append a new cart snapshot to the session. */
export async function writeCart(env: Env, threadId: string, cart: Cart): Promise<void> {
  if (!threadId) return;
  const session = openSession(env, threadId);
  await session.append({
    kind: 'audit',
    role: 'system',
    content: JSON.stringify(cart),
    metadata: { type: CART_META_TYPE, pinned: true },
  });
}

/** Add (or accumulate) an item, snapshotting title + price from the catalog. */
export function addItem(cart: Cart, item: CartItem): Cart {
  const items = cart.items.slice();
  const existing = items.findIndex((i) => i.product_id === item.product_id);
  if (existing >= 0) {
    items[existing] = { ...items[existing]!, qty: items[existing]!.qty + item.qty };
  } else {
    items.push(item);
  }
  return { ...cart, items };
}

/** Set an item's quantity; qty <= 0 removes it. */
export function setQty(cart: Cart, productId: string, qty: number): Cart {
  const items =
    qty <= 0
      ? cart.items.filter((i) => i.product_id !== productId)
      : cart.items.map((i) => (i.product_id === productId ? { ...i, qty } : i));
  return { ...cart, items };
}

export function removeItem(cart: Cart, productId: string): Cart {
  return { ...cart, items: cart.items.filter((i) => i.product_id !== productId) };
}
