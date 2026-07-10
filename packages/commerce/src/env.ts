/**
 * Commerce-contributed env vars, merged into the core `Env` interface via
 * TypeScript module augmentation. Imported by `src/commerce/plugin.ts`, so
 * the augmentation is in the program exactly when the plugin is installed.
 * Values still arrive through the same wrangler vars/secrets as before —
 * this file only owns the *types* (and their documentation).
 */

declare module '@felix/orchestrator/env' {
  interface Env {
    // ---- Commerce (Stripe direct) ----
    /**
     * Stripe secret key (`sk_live_…` / `sk_test_…`). Used by the
     * `commerce_checkout` tool to create hosted Checkout Sessions. Set via
     * `wrangler secret put STRIPE_SECRET_KEY`. When unset, the tool returns a
     * `transport_unavailable` soft error so the model can tell the user
     * checkout is unavailable rather than crashing.
     */
    STRIPE_SECRET_KEY?: string;
    /**
     * Stripe webhook signing secret (`whsec_…`). Required by
     * `POST /commerce/stripe/webhook` to verify the `stripe-signature` header.
     * When unset, the webhook route returns 503.
     */
    STRIPE_WEBHOOK_SECRET?: string;
    /** Optional override for the Checkout success redirect (defaults to shop.felix.run). */
    STRIPE_SUCCESS_URL?: string;
    /** Optional override for the Checkout cancel redirect (defaults to shop.felix.run). */
    STRIPE_CANCEL_URL?: string;
    /**
     * When `'true'`, the buyer-side Stripe Checkout Session enables
     * `automatic_tax` (requires Stripe Tax configured on the account). Off by
     * default so dev/test and non-Stripe-Tax accounts aren't broken.
     */
    STRIPE_AUTOMATIC_TAX?: string;
    /**
     * Flat sales-tax rate in basis points (100 = 1%) applied by the ACP merchant
     * checkout's tax seam to (subtotal + shipping). Default 0 (no tax). Swap the
     * `computeTax` seam for a real provider (Stripe Tax / TaxJar) later.
     */
    COMMERCE_TAX_BPS?: string;
    /**
     * JSON shipping config: `{ "free_threshold_cents"?: number, "options":
     * [{ "id", "title", "subtitle", "carrier", "amount_cents", "min_days",
     * "max_days" }] }`. Invalid/missing falls back to standard/express defaults.
     */
    COMMERCE_SHIPPING?: string;
    /**
     * JSON carrier rate-shopping config: `{ "carriers": [{ "id", "carrier",
     * "services": [{ "id", "title", "base_cents", "per_item_cents?", "min_days",
     * "max_days" }] }], "intl_multiplier"?: number, "domestic_countries"?: [..] }`.
     * When set, shipping options are quoted per-carrier (cheapest first) instead of
     * the static `COMMERCE_SHIPPING` list.
     */
    COMMERCE_CARRIERS?: string;
    /**
     * Webhook URL for abandoned-cart recovery delivery. When set, the cron POSTs
     * `{ type: 'abandoned_cart', tenant_id, thread_id, customer_id, email, ... }`
     * here for the brand to drive an email/SMS recovery. Unset → audit-only.
     */
    COMMERCE_RECOVERY_WEBHOOK?: string;
    /** CSV of ISO-3166 alpha-2 countries the buyer-side checkout ships to. Default `US`. */
    COMMERCE_SHIP_COUNTRIES?: string;
    /**
     * When `'true'`, `commerce_checkout` denies until a granted consent exists for
     * the thread (the agent must call `commerce_record_consent` first). Attribution
     * is always recorded regardless; this flag only gates the purchase.
     */
    COMMERCE_REQUIRE_CONSENT?: string;
    /** Terms version stamped on captured consent rows. */
    COMMERCE_TERMS_VERSION?: string;
    /** Privacy-policy URL stamped on captured consent rows. */
    COMMERCE_PRIVACY_URL?: string;
    /**
     * Default B2B billing provider when a tenant hasn't chosen one
     * (`billing_settings`). `internal` (manual mark-paid) or `stripe` (Stripe
     * Invoices) or any registered provider. Defaults to `internal`.
     */
    BILLING_PROVIDER_DEFAULT?: string;
    /**
     * Bearer API key the merchant (us) issues to agents calling the Agentic
     * Commerce Protocol endpoints under `/acp/*`. Compared in constant time
     * against the request `Authorization: Bearer …`. When unset, all `/acp`
     * routes return 503 (the protocol surface is disabled).
     */
    ACP_API_KEY?: string;
    /**
     * Merchant tenant that owns the ACP catalog + orders. ACP is single-merchant;
     * sessions, products, and orders all resolve under this tenant. Defaults to
     * `default` (the tenant the seed catalog lands under).
     */
    ACP_MERCHANT_TENANT?: string;
    /**
     * Optional JSON override for the GEO-monitoring cron knobs:
     * `{ "max_queries_per_tick"?: number, "gen_model"?: string, "extract_model"?: string }`.
     * Missing/invalid fields fall back to `DEFAULT_GEO_MONITOR_OPTS`; see
     * `parseGeoMonitorOpts` in `src/geo/monitor-job.ts`.
     */
    GEO_MONITOR?: string;
  }
}

export {};
