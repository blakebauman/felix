---
description: "Agentic Commerce Protocol merchant endpoint at /acp — catalog feed, checkout sessions, and ACP_API_KEY authentication."
---

# ACP merchant endpoint

`packages/commerce/src/acp/` implements the merchant side of the [Agentic Commerce Protocol](https://developers.openai.com/commerce) so external buyer agents (e.g. ChatGPT shopping) can discover the catalog and check out, mounted at `/acp`.

| Method + path | Purpose |
|---|---|
| `GET /acp/feed` | paginated product feed (`?limit&offset`), OpenAI product-feed shape |
| `POST /acp/checkout_sessions` | create a session from `{items, buyer, fulfillment_address}` |
| `GET /acp/checkout_sessions/:id` | retrieve |
| `POST /acp/checkout_sessions/:id` | update (terminal sessions are no-ops) |
| `POST /acp/checkout_sessions/:id/complete` | charge + create order (idempotent) |
| `POST /acp/checkout_sessions/:id/cancel` | cancel |

**Auth**: `/acp` is declared in the commerce plugin's `selfAuthenticatingMounts` (threaded into `authMiddleware` by `createApp`), so the global JWT middleware skips bearer parsing for it. The router compares `Authorization: Bearer …` against `env.ACP_API_KEY` in constant time (`src/security/constant-time.ts`); when the key is unset the surface returns 503 `not_configured`. Single-merchant: sessions belong to `env.ACP_MERCHANT_TENANT` (default `default`).

**Pricing is server-side only** — the buyer agent supplies items, address, and a payment token, never amounts. `complete` rebuilds the session to lock pricing, then settles a **Stripe Shared Payment Token** by creating + confirming a PaymentIntent (delegated payment: buyer credentials never reach the Worker). Sessions persist in D1 `acp_checkout_sessions` (full session JSON with `status` / `order_id` promoted to columns).

Payment idempotency for `complete` is shared with the conversational checkout path — see [Conversational shopping](./shopping.md).
