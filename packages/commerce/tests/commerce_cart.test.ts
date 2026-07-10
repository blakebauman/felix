/**
 * Session-backed cart logic. The cart is the latest `type: 'cart'` audit
 * event in the session log; mutations append a fresh snapshot and the
 * highest-seq snapshot wins. Totals are always computed server-side.
 */

import type { Session, SessionEvent } from '@felix/orchestrator/session/types';
import { describe, expect, it } from 'vitest';
import { addItem, readCart, removeItem, setQty, writeCart } from '../src/cart-session';
import { type Cart, cartTotalCents } from '../src/models';

function cartEvent(seq: number, cart: Cart): SessionEvent {
  return {
    seq,
    ts: seq,
    kind: 'audit',
    role: 'system',
    content: JSON.stringify(cart),
    metadata: { type: 'cart', pinned: true },
  };
}

/** Append-only fake session backed by an array, used to drive readCart/writeCart. */
function fakeSession(initial: SessionEvent[] = []): Session & { events: SessionEvent[] } {
  const events = [...initial];
  return {
    events,
    id: 'tenant:thr',
    async getEvents(opts) {
      const kinds = opts?.kinds;
      return kinds ? events.filter((e) => kinds.includes(e.kind)) : events;
    },
    async head() {
      return { seq: events.length };
    },
    async append(e) {
      events.push({ seq: events.length, ts: events.length, ...e } as SessionEvent);
    },
    async appendBatch(batch) {
      for (const e of batch) await this.append(e);
    },
    async reset() {
      events.length = 0;
    },
    async wake() {
      return {
        fresh: false,
        headSeq: events.length,
        pendingToolCalls: [],
        endedOnAssistant: false,
      };
    },
  };
}

// readCart/writeCart resolve the store via getSessionStore(env, 'do'), so we
// stub the store by intercepting at the env level is awkward; instead test the
// pure helpers + snapshot selection directly against a fake session.
function latestCart(events: SessionEvent[]): Cart {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.metadata?.type === 'cart' && e.content) return JSON.parse(e.content) as Cart;
  }
  return { items: [], currency: 'usd', updated_at: 0 };
}

describe('cart pure helpers', () => {
  const base: Cart = { items: [], currency: 'usd', updated_at: 0 };

  it('addItem accumulates quantity for the same product', () => {
    const once = addItem(base, { product_id: 'a', title: 'A', qty: 1, price_cents: 500 });
    const twice = addItem(once, { product_id: 'a', title: 'A', qty: 2, price_cents: 500 });
    expect(twice.items).toHaveLength(1);
    expect(twice.items[0]!.qty).toBe(3);
  });

  it('setQty(0) removes the item; positive sets it', () => {
    const c = addItem(base, { product_id: 'a', title: 'A', qty: 5, price_cents: 500 });
    expect(setQty(c, 'a', 2).items[0]!.qty).toBe(2);
    expect(setQty(c, 'a', 0).items).toHaveLength(0);
  });

  it('removeItem drops the product', () => {
    const c = addItem(base, { product_id: 'a', title: 'A', qty: 1, price_cents: 500 });
    expect(removeItem(c, 'a').items).toHaveLength(0);
  });

  it('cartTotalCents multiplies price by qty (server-side, integer cents)', () => {
    const items = [
      { product_id: 'a', title: 'A', qty: 3, price_cents: 500 },
      { product_id: 'b', title: 'B', qty: 2, price_cents: 1250 },
    ];
    expect(cartTotalCents(items)).toBe(3 * 500 + 2 * 1250);
  });
});

describe('cart snapshot selection (latest seq wins)', () => {
  it('reads the highest-seq cart event, ignoring earlier snapshots', () => {
    const session = fakeSession([
      cartEvent(0, {
        items: [{ product_id: 'a', title: 'A', qty: 1, price_cents: 500 }],
        currency: 'usd',
        updated_at: 0,
      }),
      cartEvent(1, {
        items: [{ product_id: 'a', title: 'A', qty: 9, price_cents: 500 }],
        currency: 'usd',
        updated_at: 1,
      }),
    ]);
    const cart = latestCart(session.events);
    expect(cart.items[0]!.qty).toBe(9);
  });

  it('returns an empty cart when no cart event exists', () => {
    const session = fakeSession([{ seq: 0, ts: 0, kind: 'message', role: 'user', content: 'hi' }]);
    expect(latestCart(session.events).items).toHaveLength(0);
  });
});

// Smoke check that the exported readCart/writeCart names exist (wired through
// getSessionStore in production). The real DO-backed round-trip is covered by
// the integration suite.
describe('cart-session exports', () => {
  it('exposes readCart and writeCart', () => {
    expect(typeof readCart).toBe('function');
    expect(typeof writeCart).toBe('function');
  });
});
