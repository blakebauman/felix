---
description: "Per-brand D2C storefronts at /shop with embeddable /widget, brand provisioning, catalog import, and custom domain wiring."
---

# D2C storefronts

Per-brand agents provisioned as manifests, served publicly at `/shop`, and embeddable anywhere via `/widget`. Brand management (`/brands`) is operator-side and gated `brands:write`.

**Brands** (`packages/commerce/src/brands/`, `/brands`, writes gated `brands:write`) — a brand record lives under the operator tenant; the brand's *data* (catalog, orders, manifest) lives under its own `brand_tenant`. `POST /brands` provisions the brand: `provision.ts` derives a per-brand `orderloop` manifest from the bundled base (inheriting the tool list and checkout approval), overlays the brand's voice/identity onto the system prompt, and writes + activates it under `brand_tenant` — from then on `resolveManifest(brand_tenant, 'orderloop')` returns the branded agent. Also: catalog import (`POST /brands/:id/catalog`), embedding backfill (`POST /brands/:id/reindex`), and custom-domain mapping (`POST /brands/:id/domains` → Postgres `brand_domains`, keyed by host — the one deliberately tenant-less table, since it routes anonymous public traffic).

**Storefront serving** (`packages/commerce/src/storefront/router.ts`, `/shop`) — public, anonymous. The brand resolves from the `:storefront` path segment or the `Host` header (via `brand_domains`). `GET /shop/config`, `POST /shop/chat`, `POST /shop/chat/stream` (SSE), `POST /shop/visual-search` (multipart image, 8 MB). Requests run the brand's agent under `runWithBrandContext` scoped to `brand_tenant`; thread ids are namespaced `<brand_tenant>:<suffix>` so brands are isolated.

**Widget** (`storefront/widget.ts`, `/widget`) — `GET /widget/loader.js` injects a launcher button + iframe; `GET /widget/frame` is a self-contained SSR chat UI (no build step) that streams from `/shop/:storefront/chat/stream`, rendering product cards from `catalog_*` output and a Pay button from `commerce_checkout` output. Embed with:

```html
<script src="https://<worker>/widget/loader.js" data-storefront="<brand_tenant>" async></script>
```

`frame-ancestors` is locked to the brand's registered domains once any are registered.

See [Discoverability (GEO/AEO)](./discoverability.md) for how storefront brands surface in schema.org feeds and answer engines, and [Personalization, visual search, dynamic pricing](./personalization.md) for the visual-search model behind `/shop/visual-search`.
