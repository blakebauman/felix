---
description: "Universal Commerce Protocol merchant endpoint at /ucp — checkout sessions, /.well-known/ucp discovery, and UCP_API_KEY authentication."
---

# UCP merchant endpoint

`packages/commerce/src/ucp/` implements the merchant side of the [Universal Commerce Protocol](https://ucp.dev) (spec version `2026-04-08`, checkout capability + fulfillment extension) so UCP platforms (e.g. Google shopping surfaces) can check out against the same catalog the ACP surface sells. Sibling of the [ACP endpoint](./acp.md) over the same protocol-neutral seams (catalog, shipping, tax, orders) — two thin protocol routers, one checkout engine.

| Method + path | Purpose |
|---|---|
| `GET /.well-known/ucp` | public discovery profile: version, capabilities, `/ucp` REST endpoint, payment handlers (404 until `UCP_API_KEY` is set) |
| `POST /ucp/checkout-sessions` | create a session from `{line_items, buyer?, fulfillment?}` |
| `GET /ucp/checkout-sessions/:id` | retrieve |
| `PUT /ucp/checkout-sessions/:id` | update (full replacement; terminal sessions → 409) |
| `POST /ucp/checkout-sessions/:id/complete` | charge + create order (idempotent per session) |
| `POST /ucp/checkout-sessions/:id/cancel` | cancel (completed sessions → 409) |

**Auth**: `/ucp` is declared in the commerce plugin's `selfAuthenticatingMounts`, so the global JWT middleware passes it through as anonymous. The router compares `Authorization: Bearer …` against `env.UCP_API_KEY` in constant time; when the key is unset the surface returns 503 and the discovery document 404s. Single-merchant: sessions belong to `env.UCP_MERCHANT_TENANT` (default `default`). A `UCP-Agent: … version="YYYY-MM-DD"` header newer than the server's spec version is rejected with 400 (version negotiation).

**Statuses + shapes** follow the UCP checkout schema: `incomplete → ready_for_complete → completed | canceled`, line items carrying per-line `totals[]`, session `totals[]` holding the spec invariant (Σ non-`total` == `total`), domain errors as `messages[]` with `severity`, and HTTP-level errors as the reference server's `{detail}` shape. Fulfillment is modeled as one `shipping` method with one option group; shipping options come from the same configurable seam as ACP (`COMMERCE_SHIPPING` / `COMMERCE_CARRIERS`), tax from `COMMERCE_TAX_BPS`.

**Pricing is server-side only** — the platform supplies items, destination, and a payment instrument, never amounts. `complete` rebuilds the session to lock pricing, then settles the instrument's `credential.token` (a Stripe-chargeable gateway token) by creating + confirming a PaymentIntent with a per-session idempotency key; the deterministic `ucp_order_<session>` order id keeps retried completes from duplicating orders or double-decrementing inventory. Sessions persist in Postgres `ucp_checkout_sessions` (full session JSON with `status` / `order_id` promoted to columns; migration `0002_commerce_ucp_checkout_sessions.sql`). Completed orders record attribution under channel `ucp` and emit a `commerce_order` audit event with `payload.source: 'ucp'`.

Not yet implemented (deliberately out of v1 scope): the Identity Linking capability (OAuth authorization server), AP2 payment mandates, `Idempotency-Key` request records, discounts, and pickup/digital fulfillment methods.
