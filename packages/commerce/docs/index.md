# Agentic commerce

Felix Commerce is the conversational-commerce layer built on the harness. It adds no new harness abstractions — it is a vertical assembled from the existing seams: commerce capabilities are ordinary `Tool`s, the cart lives in the append-only session log, checkout rides the human-in-the-loop approvals pipeline, brand storefronts are per-tenant manifests resolved through the standard 4-layer resolver, and B2B data flows through a pluggable entity data-source seam. All money is integer cents. Everything is tenant-scoped.

The whole layer is the **`@felix/commerce`** workspace package (`packages/commerce/`), exporting a single **`FelixPlugin`** (`packages/commerce/src/plugin.ts`; contract in `packages/harness/src/plugins/types.ts`): its routers, tool factories, cron tasks (abandoned-cart scan, GEO monitor), the `/acp` self-authenticating mount, the storefront/ACP rate-limit keying, and the 12 MB body-size floor for visual-search uploads are all declared there. The `@felix/api` Worker wires it in through the one `commercePlugin` entry in `apps/api/src/composition.ts:installedPlugins()`; the harness itself is commerce-blind — enforced by `apps/api/tests/unit/plugin_boundary.test.ts`. The package consumes harness seams via `@felix/harness/<path>` source exports (both packages export TS source; no build step), and commerce env vars merge into the harness `Env` interface via module augmentation in `packages/commerce/src/env.ts`.

## Layer map

The surfaces, roughly buyer-side → merchant-side, each detailed on its own page:

| Page | Mount | What it is |
|---|---|---|
| [Conversational shopping](./shopping.md) | agent tools (`catalog_*`, `cart_*`, `commerce_checkout`, …) | catalog → cart → approval-gated Stripe checkout inside any chat surface |
| [ACP merchant endpoint](./acp.md) | `/acp` | [Agentic Commerce Protocol](https://developers.openai.com/commerce) feed + checkout sessions for external buyer agents |
| [D2C storefronts](./storefronts.md) | `/shop`, `/widget`, `/brands` | per-brand provisioned agents, embeddable chat widget, catalog import |
| [Discoverability (GEO/AEO)](./discoverability.md) | `/structured`, root `robots.txt` / `sitemap.xml` / `.well-known/ai-catalog.json`, `/geo` | schema.org JSON-LD surfaces for answer engines + brand-visibility monitoring |
| [B2B quote-to-cash](./b2b.md) | `/b2b`, `/b2b/billing`, `/entities`, procurement manifests | accounts, buyers, purchase authority, quotes → invoices, billing providers, and the entity data-source seam |
| [Personalization, visual search, dynamic pricing](./personalization.md) | agent tools (`recommend_products`, `search_by_image`, …), abandoned-cart cron | behavior-driven recommendations, image search, and rule-based repricing |
| [Data model + configuration](./data-model.md) | `/commerce/consents`, `/commerce/attribution/*` | D1 schema + migrations, env vars, consent log, per-order attribution |

## Tool catalog

All registered by `commercePlugin.registerTools` (`packages/commerce/src/plugin.ts`); any manifest can pick them up by name.

| Group | Tools |
|---|---|
| Catalog / cart / orders | `catalog_search`, `catalog_get`, `catalog_categories`, `cart_view`, `cart_add`, `cart_update`, `cart_remove`, `order_status` |
| Checkout / consent | `commerce_checkout` (approval-gated), `commerce_record_consent` |
| Personalization | `recommend_products`, `identify_customer` |
| Visual | `search_by_image` |
| B2B | `account_get`, `buyer_get`, `purchase_authority_check`, `price_lookup`, `create_quote`, `quote_get`, `send_quote`, `accept_quote`, `convert_quote`, `invoice_get`, `pay_invoice` |

Bundled commerce manifests: `orderloop` (D2C buyer agent — react, anonymous-allowed, `checkout-confirm` approval, `windowed:24` session), `shopping` (standalone shopping agent), `procurement` + `procurement-catalog` / `procurement-quoting` / `procurement-billing` (B2B multi-agent).
