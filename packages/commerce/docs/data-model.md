---
description: "Commerce Postgres schema, environment variables, consent log, per-order attribution, and Stripe configuration."
---

# Data model + configuration

**Schema**: commerce's ~25 tables — `products` / `orders` / `order_items`, `acp_checkout_sessions`, `brands` / `brand_domains`, `data_sources`, `accounts` / `buyers`, `quotes` / `quote_items` / `invoices`, `contract_prices`, `billing_settings`, `geo_queries` / `geo_observations`, `consents` / `order_attribution`, `customers` / `customer_sessions` / `behavior_events` / `abandoned_carts`, `pricing_rules` / `competitor_prices` — all live alongside the harness core tables in `apps/api/migrations/0001_baseline.sql` (the single Postgres baseline that collapsed the old D1 migration sequence). All follow the composite tenant-key convention except `brand_domains` (host-keyed by design). `products` also carries a generated `search_tsv` tsvector column + a `pg_trgm` index on `title` powering `catalog_search`'s full-text search — see [persistence.md](../../harness/docs/internals/persistence.md). Harness core and commerce share one Postgres database and the same `apps/api/migrations/` directory; name new commerce-owned migration files `NNNN_commerce_*` so ownership stays legible.

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

`packages/commerce/src/consent/` (tool + store + the `/commerce/consents` router). Postgres `consents` is **append-only** — withdrawal is a new `granted: false` row, never an update; the latest row per thread is authoritative. The `commerce_record_consent` tool captures `granted` + `scopes[]` (e.g. `["terms","data_share","marketing"]`), stamping `COMMERCE_TERMS_VERSION` / `COMMERCE_PRIVACY_URL`, and emits a `consent_recorded` audit event. Every order gets an `order_attribution` row (`channel` ∈ `chat|acp|b2b|widget`, `manifest_id`, `thread_id`, `buyer_subject`, `consent_id`, `utm`) written by the Stripe webhook, ACP complete, and B2B convert. Read APIs (gated `consent:read`): `GET /commerce/consents`, `GET /commerce/attribution/summary` (agent-mediated revenue by channel/manifest), `GET /commerce/attribution/orders/:id`.
