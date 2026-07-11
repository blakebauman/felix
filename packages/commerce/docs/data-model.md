---
description: "Commerce D1 migrations 0006–0018, environment variables, consent log, per-order attribution, and Stripe configuration."
---

# Data model + configuration

**Migrations** `0006`–`0018`: `products` / `orders` / `order_items` (0006), `acp_checkout_sessions` (0007), `brands` (0008), `brand_domains` (0009), `data_sources` (0010), `accounts` / `buyers` (0011), `quotes` / `quote_items` / `invoices` (0012), `contract_prices` (0013), `billing_settings` (0014), `geo_queries` / `geo_observations` (0015), `consents` / `order_attribution` (0016), `customers` / `customer_sessions` / `behavior_events` / `abandoned_carts` (0017), `pricing_rules` / `competitor_prices` (0018). All follow the composite tenant-key convention except `brand_domains` (host-keyed by design). See [persistence.md](../../harness/docs/internals/persistence.md). Harness core (`0001`–`0005`) and commerce share one D1 database and one migrations dir (`apps/api/migrations/`); name new commerce-owned migrations `NNNN_commerce_*` so ownership stays legible.

**Env / secrets** (typed in `packages/commerce/src/env.ts`, except `CONSUMER_SHARED_SECRET` which is core):

| Var | Purpose |
|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe API + webhook signature (secrets) |
| `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, `STRIPE_AUTOMATIC_TAX` | checkout redirect + tax toggles |
| `ACP_API_KEY`, `ACP_MERCHANT_TENANT` | ACP bearer key (secret) + merchant tenant |
| `COMMERCE_TAX_BPS`, `COMMERCE_SHIPPING`, `COMMERCE_CARRIERS`, `COMMERCE_SHIP_COUNTRIES` | tax/shipping/carrier config |
| `COMMERCE_RECOVERY_WEBHOOK` | abandoned-cart recovery dispatch target |
| `COMMERCE_REQUIRE_CONSENT`, `COMMERCE_TERMS_VERSION`, `COMMERCE_PRIVACY_URL` | consent gate config |
| `CONSUMER_SHARED_SECRET` | entity push + internal write-back auth (secret) |
| `GEO_MONITOR` | GEO cron tuning JSON |
| `BILLING_PROVIDER_DEFAULT` | default B2B billing provider |

**Security posture** (hardened in the control-plane authz pass): commerce writes require scopes (`brands:write`, `b2b:write`, `entities:write`, `geo:write`; consent/attribution reads `consent:read`); ACP / entity-push / webhooks authenticate with constant-time compares or Stripe signatures rather than JWT; all outbound fetches (connectors, carriers, recovery webhook, image URLs) pass the canonicalizing SSRF guard; payments are idempotent under retry.

## Consent + attribution

`packages/commerce/src/consent/` (tool + store + the `/commerce/consents` router). D1 `consents` is **append-only** — withdrawal is a new `granted: 0` row, never an update; the latest row per thread is authoritative. The `commerce_record_consent` tool captures `granted` + `scopes[]` (e.g. `["terms","data_share","marketing"]`), stamping `COMMERCE_TERMS_VERSION` / `COMMERCE_PRIVACY_URL`, and emits a `consent_recorded` audit event. Every order gets an `order_attribution` row (`channel` ∈ `chat|acp|b2b|widget`, `manifest_id`, `thread_id`, `buyer_subject`, `consent_id`, `utm`) written by the Stripe webhook, ACP complete, and B2B convert. Read APIs (gated `consent:read`): `GET /commerce/consents`, `GET /commerce/attribution/summary` (agent-mediated revenue by channel/manifest), `GET /commerce/attribution/orders/:id`.
