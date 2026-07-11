---
description: "Behavior-driven recommendations, image search, abandoned-cart recovery, and rule-based dynamic pricing."
---

# Personalization, visual search, dynamic pricing

**Personalization** (`packages/commerce/src/personalization/`, D1 `customers`, `customer_sessions`, `behavior_events`, `abandoned_carts`): behavior telemetry (`view`, `add_to_cart`, `checkout_start`, `purchase`) is captured fire-and-forget from the catalog/cart tools. `recommend_products` runs Vectorize similarity seeded from a product id or the thread's recent behavior; `identify_customer` upserts a customer by email, links the session, and back-attaches the thread's behavior events for cross-session continuity.

**Cart recovery** — the abandoned-cart cron (`packages/commerce/src/personalization/abandoned-cart-job.ts`) scans `behavior_events` for threads with purchase intent but no purchase, idle over an hour; it records `abandoned_carts` rows (deduped), emits `cart_abandoned` audit events + an `orchestrator_abandoned_carts_detected` counter, and dispatches to `COMMERCE_RECOVERY_WEBHOOK` when configured (SSRF-guarded; audit-only when unset).

**Visual search** (`packages/commerce/src/visual/`) — caption-then-embed: product images are captioned by a Workers AI vision model, the caption embedded into the same 768-dim BGE index; an uploaded query image runs the identical caption → embed → cosine path. Exposed as the `search_by_image` tool and `POST /shop/visual-search`.

**Dynamic pricing** (`packages/commerce/src/pricing/`, D1 `pricing_rules`, `competitor_prices`): rules have `scope` (`catalog|category|product`), `kind` (`time|velocity|competitor`), a signed `adjustment_bps` (negative = discount), and floor/ceiling clamps. Matching adjustments sum and clamp. Applied at catalog display and B2B quote pricing; cart items snapshot their price at add time so a rule change never silently reprices a cart.
