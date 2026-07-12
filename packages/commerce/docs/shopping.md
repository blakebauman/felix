---
description: "Catalog search, cart management, and approval-gated Stripe checkout as Felix tools — the complete D2C buyer flow."
---

# Conversational shopping

The buyer-side agent tools — `catalog_*`, `cart_*`, `commerce_checkout`, `order_status` — that turn any chat surface (native `/chat`, `/v1/chat/completions`, A2A, a brand's `/shop` storefront) into a catalog → cart → checkout flow. All money is integer cents; the server always recomputes totals, the model never supplies amounts.

**Catalog** — `packages/commerce/src/catalog-store.ts`, Postgres `products`. Product: `id` (SKU), `title`, `description`, `price_cents`, `currency`, `image_url`, `category`, `inventory` (`-1` = unlimited), `active`, `attrs`. `catalog_search` uses Postgres full-text search: a generated `search_tsv` column (weighted title > category > description) queried via `websearch_to_tsquery`, plus a `pg_trgm` similarity arm on `title` for typo'd single-word queries ("espreso" still finds the espresso machine); results rank by `ts_rank`, then price. This replaces the old substring `LIKE` scan — stemmed matches ("running shoe" → "Trail Running Shoes") now hit. On product write, text and image-caption embeddings are pushed to Vectorize (`MEMORY_VEC`) off the response path via `waitUntil`, so catalog writes never fail on an unprovisioned index.

**Cart** — `packages/commerce/src/cart-session.ts`. Deliberately **not** a D1 table: the cart is a `kind: 'audit'` event in the ConversationDO session log with `metadata: { type: 'cart', pinned: true }`. The highest-`seq` snapshot wins; render strategies skip audit events, so the cart never pollutes the model's message window. The server always recomputes totals — the model never supplies amounts.

**Checkout** — the `commerce_checkout` tool (`packages/commerce/src/stripe-tool.ts`) reads the session cart, recomputes the total, and creates a hosted Stripe Checkout Session; card capture never touches the Worker. The tool is approval-gated in the manifests (`approvals: [{ id: checkout-confirm, tools: [commerce_checkout] }]`): the first call persists an approval request and returns a deny stub; after `POST /approvals/:id/decide`, the retry creates the session. Stripe metadata carries `tenant_id`, `thread_id`, `channel`, `manifest_id`, `buyer_subject`, `consent_id` for attribution. When `COMMERCE_REQUIRE_CONSENT=true` the tool denies until a granted consent exists for the thread.

**Orders** — `packages/commerce/src/order-store.ts`, Postgres `orders` + `order_items` (header + items written in one transaction). Status `pending | paid | fulfilled | cancelled`. The Stripe webhook (`POST /commerce/stripe/webhook`, `packages/commerce/src/webhook.ts`) verifies the Stripe signature (Web Crypto provider — no Node `http`), and on `checkout.session.completed` writes the order as `paid`, decrements inventory, records `purchase` behavior events, writes `order_attribution`, clears the cart, and emits a `commerce_order` audit event.

**Payment idempotency** — ACP completion uses a deterministic Stripe idempotency key (`acp-complete-<sessionId>`) and a deterministic order id (`acp_order_<sessionId>`) with an existence check, so retries and concurrent completions cannot double-charge or double-decrement inventory (`packages/commerce/src/acp/payment.ts`).

**Shipping, carriers, tax** — three seams designed for provider replacement:
- `packages/commerce/src/shipping.ts` — static options from `COMMERCE_SHIPPING` JSON (defaults: standard $5 / 5–7d, express $15 / 2–3d; `free_threshold_cents` zeroes the cheapest option).
- `packages/commerce/src/shipping-carriers.ts` — `COMMERCE_CARRIERS` JSON; per-carrier `static` (base + per-item × zone multiplier) or `live` (POST cart context to the carrier URL, SSRF-guarded, falls back to static on failure). `rateShop` returns quotes cheapest-first.
- `packages/commerce/src/tax.ts` — v1 flat `COMMERCE_TAX_BPS` on subtotal + shipping; the signature carries address/line context so Stripe Tax or Avalara can replace `computeTax` without touching callers. Buyer-side checkout can instead use Stripe `automatic_tax` (`STRIPE_AUTOMATIC_TAX=true`).

See [ACP merchant endpoint](./acp.md) for the equivalent flow driven by an external buyer agent, and [Tool catalog](./index.md#tool-catalog) for the full tool list.
