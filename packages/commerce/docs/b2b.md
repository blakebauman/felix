---
description: "B2B accounts, buyers, purchase authority, quote-to-invoice flow, billing providers, and the entity data-source seam."
---

# B2B quote-to-cash

`packages/commerce/src/b2b/` (+ `packages/commerce/src/billing/`), mounted at `/b2b` (+ `/b2b/billing`). Writes gated `b2b:write`; reads flow through the [entity data-source seam](#entity-data-source-seam) so any of these can be backed by a third-party ERP.

- **Accounts / buyers** (Postgres `accounts`, `buyers`): accounts carry `payment_terms` (`prepaid|net15|net30|net60`) and `credit_limit_cents`; buyers carry `role` (`admin|approver|purchaser|viewer`) and `spending_limit_cents`.
- **Purchase authority** (`authority.ts`, pure function): `allowed`, `requires_approval` (over buyer limit — routes into the standard approvals pipeline), or `blocked` (suspended account, viewer role, over credit). Exposed as `POST /b2b/accounts/:id/purchase-check` and the `purchase_authority_check` tool.
- **Contract pricing** (Postgres `contract_prices`): per-account, per-product volume tiers. `resolveEffectivePrice` layers contract tiers / account discounts over catalog, then dynamic-pricing rules; the result is tagged `contract | account_discount | dynamic | catalog`.
- **Quote-to-cash** (Postgres `quotes`, `quote_items`, `invoices`; quote + quote_items written in one `sql.begin` transaction): `draft → sent → accepted | pending_approval → ordered`. `accept` runs purchase authority (over-limit quotes park in `pending_approval` with an approval request); `convert` requires the approval to be approved, creates the order, and issues an invoice through the billing provider with net-terms due dates.
- **Billing seam** (`billing/`): an open provider registry (`registerBillingProvider`) with built-ins `internal` (Postgres tracking, explicit mark-paid) and `stripe` (creates the Stripe customer/invoice; `POST /b2b/billing/webhook` marks invoices paid on Stripe `invoice.paid`, signature-verified). Per-tenant provider selection in Postgres `billing_settings` via `GET/PUT /b2b/billing/provider`.
- **Procurement agents** — `manifests/procurement.yaml` is a router over three sub-agents (`procurement-catalog`, `procurement-quoting`, `procurement-billing`), with `convert-confirm` / `pay-confirm` approval gates on the money-moving tools.

## Entity data-source seam

`packages/commerce/src/entities/` virtualizes *data* the way the harness virtualizes tools, mounted at `/entities`. `resolveEntitySource<T>(env, tenant, type)` returns an `EntitySource<T>` (`get`/`list`) in one of three modes, configured per tenant + entity type in Postgres `data_sources`:

- `native` — Postgres is the source of truth (default).
- `federated` — live read-through to a connector; invalid config degrades to native (fail-safe).
- `synced` — Postgres populated by a pull job (`POST /entities/:type/sync`) or an inbound webhook (`POST /entities/:type/push`, authenticated by `x-consumer-secret` against `CONSUMER_SHARED_SECRET`); reads look native.

Connectors are an open registry (`registerEntityConnector`): `http` (`GET {url}/{type}/{id}`, `GET {url}/{type}?limit&cursor`) and `mcp` (JSON-RPC `tools/call` of `get_<type>` / `list_<type>`). Both are SSRF-guarded via `assertSafeOutboundUrlForEnv` and forward a configured `Authorization` header. B2B accounts, buyers, quotes, invoices, and `competitor_price` read through this seam.
