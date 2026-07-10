# Agentic commerce

Felix Commerce is the conversational-commerce layer built on the harness. It adds no new harness abstractions — it is a vertical assembled from the existing seams: commerce capabilities are ordinary `Tool`s registered in `src/composition.ts`, the cart lives in the append-only session log, checkout rides the human-in-the-loop approvals pipeline, brand storefronts are per-tenant manifests resolved through the standard 4-layer resolver, and B2B data flows through a pluggable entity data-source seam. All money is integer cents. Everything is tenant-scoped.

The surfaces, roughly buyer-side → merchant-side:

| Surface | Mount | What it is |
|---|---|---|
| Conversational shopping | agent tools (`catalog_*`, `cart_*`, `commerce_checkout`, …) | catalog → cart → approval-gated Stripe checkout inside any chat surface |
| ACP merchant endpoint | `/acp` | [Agentic Commerce Protocol](https://developers.openai.com/commerce) feed + checkout sessions for external buyer agents |
| D2C storefronts | `/shop`, `/widget`, `/brands` | per-brand provisioned agents, embeddable chat widget, catalog import |
| Discoverability (GEO/AEO) | `/structured`, root `robots.txt` / `sitemap.xml` / `.well-known/ai-catalog.json`, `/geo` | schema.org JSON-LD surfaces for answer engines + brand-visibility monitoring |
| B2B quote-to-cash | `/b2b`, `/b2b/billing`, procurement manifests | accounts, buyers, purchase authority, quotes → invoices, billing providers |
| Entity seam | `/entities` | back B2B/commerce entities with native D1, live federation, or webhook sync |
| Consent + attribution | `/commerce/consents`, `/commerce/attribution/*` | append-only consent log, per-order channel attribution |

## Conversational commerce core

**Catalog** — `src/commerce/catalog-store.ts`, D1 `products` (`0006_commerce.sql`). Product: `id` (SKU), `title`, `description`, `price_cents`, `currency`, `image_url`, `category`, `inventory` (`-1` = unlimited), `active`, `attrs`. On product write, text and image-caption embeddings are pushed to Vectorize (`MEMORY_VEC`) off the response path via `waitUntil`, so catalog writes never fail on an unprovisioned index.

**Cart** — `src/commerce/cart-session.ts`. Deliberately **not** a D1 table: the cart is a `kind: 'audit'` event in the ConversationDO session log with `metadata: { type: 'cart', pinned: true }`. The highest-`seq` snapshot wins; render strategies skip audit events, so the cart never pollutes the model's message window. The server always recomputes totals — the model never supplies amounts.

**Checkout** — the `commerce_checkout` tool (`src/commerce/stripe-tool.ts`) reads the session cart, recomputes the total, and creates a hosted Stripe Checkout Session; card capture never touches the Worker. The tool is approval-gated in the manifests (`approvals: [{ id: checkout-confirm, tools: [commerce_checkout] }]`): the first call persists an approval request and returns a deny stub; after `POST /approvals/:id/decide`, the retry creates the session. Stripe metadata carries `tenant_id`, `thread_id`, `channel`, `manifest_id`, `buyer_subject`, `consent_id` for attribution. When `COMMERCE_REQUIRE_CONSENT=true` the tool denies until a granted consent exists for the thread.

**Orders** — `src/commerce/order-store.ts`, D1 `orders` + `order_items`. Status `pending | paid | fulfilled | cancelled`. The Stripe webhook (`POST /commerce/stripe/webhook`, `src/commerce/webhook.ts`) verifies the Stripe signature (Web Crypto provider — no Node `http`), and on `checkout.session.completed` writes the order as `paid`, decrements inventory, records `purchase` behavior events, writes `order_attribution`, clears the cart, and emits a `commerce_order` audit event.

**Payment idempotency** — ACP completion uses a deterministic Stripe idempotency key (`acp-complete-<sessionId>`) and a deterministic order id (`acp_order_<sessionId>`) with an existence check, so retries and concurrent completions cannot double-charge or double-decrement inventory (`src/commerce/acp/payment.ts`).

**Shipping, carriers, tax** — three seams designed for provider replacement:
- `src/commerce/shipping.ts` — static options from `COMMERCE_SHIPPING` JSON (defaults: standard $5 / 5–7d, express $15 / 2–3d; `free_threshold_cents` zeroes the cheapest option).
- `src/commerce/shipping-carriers.ts` — `COMMERCE_CARRIERS` JSON; per-carrier `static` (base + per-item × zone multiplier) or `live` (POST cart context to the carrier URL, SSRF-guarded, falls back to static on failure). `rateShop` returns quotes cheapest-first.
- `src/commerce/tax.ts` — v1 flat `COMMERCE_TAX_BPS` on subtotal + shipping; the signature carries address/line context so Stripe Tax or Avalara can replace `computeTax` without touching callers. Buyer-side checkout can instead use Stripe `automatic_tax` (`STRIPE_AUTOMATIC_TAX=true`).

## ACP merchant surface (`/acp`)

`src/commerce/acp/` implements the merchant side of the Agentic Commerce Protocol so external buyer agents (e.g. ChatGPT shopping) can discover the catalog and check out.

| Method + path | Purpose |
|---|---|
| `GET /acp/feed` | paginated product feed (`?limit&offset`), OpenAI product-feed shape |
| `POST /acp/checkout_sessions` | create a session from `{items, buyer, fulfillment_address}` |
| `GET /acp/checkout_sessions/:id` | retrieve |
| `POST /acp/checkout_sessions/:id` | update (terminal sessions are no-ops) |
| `POST /acp/checkout_sessions/:id/complete` | charge + create order (idempotent) |
| `POST /acp/checkout_sessions/:id/cancel` | cancel |

**Auth**: `/acp` is listed in `SELF_AUTHENTICATING_MOUNTS` (`src/auth/middleware.ts`), so the global JWT middleware skips bearer parsing for it. The router compares `Authorization: Bearer …` against `env.ACP_API_KEY` in constant time (`src/security/constant-time.ts`); when the key is unset the surface returns 503 `not_configured`. Single-merchant: sessions belong to `env.ACP_MERCHANT_TENANT` (default `default`).

**Pricing is server-side only** — the buyer agent supplies items, address, and a payment token, never amounts. `complete` rebuilds the session to lock pricing, then settles a **Stripe Shared Payment Token** by creating + confirming a PaymentIntent (delegated payment: buyer credentials never reach the Worker). Sessions persist in D1 `acp_checkout_sessions` (full session JSON with `status` / `order_id` promoted to columns).

## D2C: brands, storefronts, widget

**Brands** (`src/commerce/brands/`, `/brands`, writes gated `brands:write`) — a brand record lives under the operator tenant; the brand's *data* (catalog, orders, manifest) lives under its own `brand_tenant`. `POST /brands` provisions the brand: `provision.ts` derives a per-brand `orderloop` manifest from the bundled base (inheriting the tool list and checkout approval), overlays the brand's voice/identity onto the system prompt, and writes + activates it under `brand_tenant` — from then on `resolveManifest(brand_tenant, 'orderloop')` returns the branded agent. Also: catalog import (`POST /brands/:id/catalog`), embedding backfill (`POST /brands/:id/reindex`), and custom-domain mapping (`POST /brands/:id/domains` → D1 `brand_domains`, keyed by host — the one deliberately tenant-less table, since it routes anonymous public traffic).

**Storefront serving** (`src/commerce/storefront/router.ts`, `/shop`) — public, anonymous. The brand resolves from the `:storefront` path segment or the `Host` header (via `brand_domains`). `GET /shop/config`, `POST /shop/chat`, `POST /shop/chat/stream` (SSE), `POST /shop/visual-search` (multipart image, 8 MB). Requests run the brand's agent under `runWithBrandContext` scoped to `brand_tenant`; thread ids are namespaced `<brand_tenant>:<suffix>` so brands are isolated.

**Widget** (`storefront/widget.ts`, `/widget`) — `GET /widget/loader.js` injects a launcher button + iframe; `GET /widget/frame` is a self-contained SSR chat UI (no build step) that streams from `/shop/:storefront/chat/stream`, rendering product cards from `catalog_*` output and a Pay button from `commerce_checkout` output. Embed with:

```html
<script src="https://<worker>/widget/loader.js" data-storefront="<brand_tenant>" async></script>
```

`frame-ancestors` is locked to the brand's registered domains once any are registered.

## Discoverability: structured data + GEO monitoring

**Structured data** (`src/commerce/structured/`, public, brand-resolved, gated on the brand's `identity.structured_data.enabled`): `GET /structured/feed.jsonld` (schema.org `ItemList`), `GET /structured/products/:id` (`Product` + `BreadcrumbList` in a `@graph`), plus `sitemap.xml` and `robots.txt` — each also available under `/structured/:storefront/*`. Root aliases serve host-resolved `GET /robots.txt`, `GET /sitemap.xml`, and `GET /.well-known/ai-catalog.json` (a discovery document pointing answer engines at the feed — the commerce analogue of the agent card). Responses carry weak ETags + `Cache-Control`.

**GEO/AEO monitoring** (`src/geo/`, API `src/api/geo.ts` at `/geo`, cron `src/jobs/geo-monitor.ts`) answers "how does this brand show up when an AI does the shopping?" Tenants register tracked queries (`POST /geo/queries`, gated `geo:write`); each cron tick replays active queries through a generative engine (Workers AI by default), extracts whether the brand was `mentioned`, its `rank`, `competitors[]`, and `products[]`, and writes `geo_observations` plus a `geo_observation` audit event, `orchestrator_geo_mention` counter, and `orchestrator_geo_rank` histogram. Read back via `GET /geo/observations` and `GET /geo/summary`. Tuned by the `GEO_MONITOR` env JSON.

## B2B: accounts, authority, quote-to-cash

`src/commerce/b2b/` (+ `src/commerce/billing/`). Writes gated `b2b:write`; reads flow through the entity seam so any of these can be backed by a third-party ERP.

- **Accounts / buyers** (D1 `accounts`, `buyers`): accounts carry `payment_terms` (`prepaid|net15|net30|net60`) and `credit_limit_cents`; buyers carry `role` (`admin|approver|purchaser|viewer`) and `spending_limit_cents`.
- **Purchase authority** (`authority.ts`, pure function): `allowed`, `requires_approval` (over buyer limit — routes into the standard approvals pipeline), or `blocked` (suspended account, viewer role, over credit). Exposed as `POST /b2b/accounts/:id/purchase-check` and the `purchase_authority_check` tool.
- **Contract pricing** (D1 `contract_prices`): per-account, per-product volume tiers. `resolveEffectivePrice` layers contract tiers / account discounts over catalog, then dynamic-pricing rules; the result is tagged `contract | account_discount | dynamic | catalog`.
- **Quote-to-cash** (D1 `quotes`, `quote_items`, `invoices`): `draft → sent → accepted | pending_approval → ordered`. `accept` runs purchase authority (over-limit quotes park in `pending_approval` with an approval request); `convert` requires the approval to be approved, creates the order, and issues an invoice through the billing provider with net-terms due dates.
- **Billing seam** (`billing/`): an open provider registry (`registerBillingProvider`) with built-ins `internal` (D1 tracking, explicit mark-paid) and `stripe` (creates the Stripe customer/invoice; `POST /b2b/billing/webhook` marks invoices paid on Stripe `invoice.paid`, signature-verified). Per-tenant provider selection in D1 `billing_settings` via `GET/PUT /b2b/billing/provider`.
- **Procurement agents** — `manifests/procurement.yaml` is a router over three sub-agents (`procurement-catalog`, `procurement-quoting`, `procurement-billing`), with `convert-confirm` / `pay-confirm` approval gates on the money-moving tools.

## Entity data-source seam

`src/entities/` virtualizes *data* the way the harness virtualizes tools. `resolveEntitySource<T>(env, tenant, type)` returns an `EntitySource<T>` (`get`/`list`) in one of three modes, configured per tenant + entity type in D1 `data_sources`:

- `native` — D1 is the source of truth (default).
- `federated` — live read-through to a connector; invalid config degrades to native (fail-safe).
- `synced` — D1 populated by a pull job (`POST /entities/:type/sync`) or an inbound webhook (`POST /entities/:type/push`, authenticated by `x-consumer-secret` against `CONSUMER_SHARED_SECRET`); reads look native.

Connectors are an open registry (`registerEntityConnector`): `http` (`GET {url}/{type}/{id}`, `GET {url}/{type}?limit&cursor`) and `mcp` (JSON-RPC `tools/call` of `get_<type>` / `list_<type>`). Both are SSRF-guarded via `assertSafeOutboundUrlForEnv` and forward a configured `Authorization` header. B2B accounts, buyers, quotes, invoices, and `competitor_price` read through this seam.

## Personalization, visual search, dynamic pricing

**Personalization** (`src/commerce/personalization/`, D1 `customers`, `customer_sessions`, `behavior_events`, `abandoned_carts`): behavior telemetry (`view`, `add_to_cart`, `checkout_start`, `purchase`) is captured fire-and-forget from the catalog/cart tools. `recommend_products` runs Vectorize similarity seeded from a product id or the thread's recent behavior; `identify_customer` upserts a customer by email, links the session, and back-attaches the thread's behavior events for cross-session continuity.

**Cart recovery** — the abandoned-cart cron (`src/jobs/abandoned-cart.ts`) scans `behavior_events` for threads with purchase intent but no purchase, idle over an hour; it records `abandoned_carts` rows (deduped), emits `cart_abandoned` audit events + an `orchestrator_abandoned_carts_detected` counter, and dispatches to `COMMERCE_RECOVERY_WEBHOOK` when configured (SSRF-guarded; audit-only when unset).

**Visual search** (`src/commerce/visual/`) — caption-then-embed: product images are captioned by a Workers AI vision model, the caption embedded into the same 768-dim BGE index; an uploaded query image runs the identical caption → embed → cosine path. Exposed as the `search_by_image` tool and `POST /shop/visual-search`.

**Dynamic pricing** (`src/commerce/pricing/`, D1 `pricing_rules`, `competitor_prices`): rules have `scope` (`catalog|category|product`), `kind` (`time|velocity|competitor`), a signed `adjustment_bps` (negative = discount), and floor/ceiling clamps. Matching adjustments sum and clamp. Applied at catalog display and B2B quote pricing; cart items snapshot their price at add time so a rule change never silently reprices a cart.

## Consent + attribution

`src/commerce/consent/` + `src/api/consent.ts`. D1 `consents` is **append-only** — withdrawal is a new `granted: 0` row, never an update; the latest row per thread is authoritative. The `commerce_record_consent` tool captures `granted` + `scopes[]` (e.g. `["terms","data_share","marketing"]`), stamping `COMMERCE_TERMS_VERSION` / `COMMERCE_PRIVACY_URL`, and emits a `consent_recorded` audit event. Every order gets an `order_attribution` row (`channel` ∈ `chat|acp|b2b|widget`, `manifest_id`, `thread_id`, `buyer_subject`, `consent_id`, `utm`) written by the Stripe webhook, ACP complete, and B2B convert. Read APIs (gated `consent:read`): `GET /commerce/consents`, `GET /commerce/attribution/summary` (agent-mediated revenue by channel/manifest), `GET /commerce/attribution/orders/:id`.

## Tool catalog

All registered in `src/composition.ts`; any manifest can pick them up by name.

| Group | Tools |
|---|---|
| Catalog / cart / orders | `catalog_search`, `catalog_get`, `catalog_categories`, `cart_view`, `cart_add`, `cart_update`, `cart_remove`, `order_status` |
| Checkout / consent | `commerce_checkout` (approval-gated), `commerce_record_consent` |
| Personalization | `recommend_products`, `identify_customer` |
| Visual | `search_by_image` |
| B2B | `account_get`, `buyer_get`, `purchase_authority_check`, `price_lookup`, `create_quote`, `quote_get`, `send_quote`, `accept_quote`, `convert_quote`, `invoice_get`, `pay_invoice` |

Bundled commerce manifests: `orderloop` (D2C buyer agent — react, anonymous-allowed, `checkout-confirm` approval, `windowed:24` session), `shopping` (standalone shopping agent), `procurement` + `procurement-catalog` / `procurement-quoting` / `procurement-billing` (B2B multi-agent).

## Data model + configuration

**Migrations** `0006`–`0018`: `products` / `orders` / `order_items` (0006), `acp_checkout_sessions` (0007), `brands` (0008), `brand_domains` (0009), `data_sources` (0010), `accounts` / `buyers` (0011), `quotes` / `quote_items` / `invoices` (0012), `contract_prices` (0013), `billing_settings` (0014), `geo_queries` / `geo_observations` (0015), `consents` / `order_attribution` (0016), `customers` / `customer_sessions` / `behavior_events` / `abandoned_carts` (0017), `pricing_rules` / `competitor_prices` (0018). All follow the composite tenant-key convention except `brand_domains` (host-keyed by design). See [persistence.md](persistence.md).

**Env / secrets** (`src/env.ts`):

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
