/**
 * Worker env binding types — single source of truth, kept in sync with
 * wrangler.jsonc. Every route handler and Durable Object receives this shape.
 */

export interface Env {
  // ---- AI ----
  AI: Ai;
  AI_GATEWAY_SLUG: string;
  AI_GATEWAY_ACCOUNT_ID: string;
  DEFAULT_MODEL_ID: string;
  /**
   * Optional JSON map override: logical model id -> { provider, model }.
   * When empty or unset, `parseModelRoutes` returns `DEFAULT_MODEL_ROUTES`
   * baked into the bundle. Set this var only when an env needs to diverge
   * from the defaults (canary models, region-specific routing, etc.).
   */
  MODEL_ROUTES?: string;
  /**
   * Optional JSON override for the continuous-eval cron knobs:
   * `{ "sample_rate"?: number, "max_replays_per_tick"?: number, "window_ms"?: number }`.
   * Missing/invalid fields fall back to `DEFAULT_CONTINUOUS_EVAL_OPTS`; see
   * `parseContinuousEvalOpts` in `jobs/continuous-eval.ts`. Tune per-env without
   * a redeploy via `wrangler secret put` / the dashboard. Unset = defaults.
   */
  CONTINUOUS_EVAL?: string;
  /**
   * Optional JSON override for the GEO-monitoring cron knobs:
   * `{ "max_queries_per_tick"?: number, "gen_model"?: string, "extract_model"?: string }`.
   * Missing/invalid fields fall back to `DEFAULT_GEO_MONITOR_OPTS`; see
   * `parseGeoMonitorOpts` in `jobs/geo-monitor.ts`.
   */
  GEO_MONITOR?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /**
   * Cloudflare AI Gateway "Authenticated Gateway" token. Sent as
   * `cf-aig-authorization: Bearer ${CF_AIG_TOKEN}` on every gateway call
   * when set. Required when the gateway slug has Authenticated Gateway
   * enabled in the dashboard; leave unset for unauthenticated gateways.
   * Generate in the AI Gateway dashboard under the slug's settings.
   */
  CF_AIG_TOKEN?: string;

  // ---- Auth ----
  /**
   * The sole inbound-auth config surface. Comma-separated verifiers; each is
   * whitespace-separated `<scheme> <issuer> [audience]` where scheme is
   * `access` (Cloudflare Access) or `cognito` (standard OIDC JWKS path).
   * See `parseVerifiers` in `auth/jwt.ts`. Empty string = no verifiers.
   */
  JWT_VERIFIERS: string;

  // ---- Persistence ----
  DB: D1Database;
  CACHE: KVNamespace;
  BUNDLES: R2Bucket;
  MEMORY_VEC: VectorizeIndex;
  AUDIT_QUEUE: Queue;

  // ---- Observability ----
  /**
   * Analytics Engine dataset for `orchestrator_*` counters and histograms.
   * `recordCounter` / `recordHistogram` write a data point when this is
   * wired and fall through to structured `console.log` when it is not —
   * so unit tests and dev probes that don't declare the binding still
   * see the signal in `wrangler tail`.
   */
  METRICS?: AnalyticsEngineDataset;

  // ---- Durable execution ----
  /**
   * Cloudflare Workflows binding. When `spec.execution.mode` is `durable`,
   * the builder wraps the compiled `Agent` in a `DurableAgent` that
   * creates a Workflow instance per invocation — survives worker
   * eviction mid-run, replays from the last completed step, and pairs
   * with A2A `tasks/resubscribe` for resume. Optional in tests; when
   * absent, the wrapper logs a warning and falls through to in-isolate
   * execution so dev loops still work without configuring the binding.
   */
  AGENT_WORKFLOW?: Workflow;

  // ---- Durable Objects ----
  CONVERSATION_DO: DurableObjectNamespace;
  A2A_TASK_DO: DurableObjectNamespace;
  APPROVALS_DO: DurableObjectNamespace;
  FEDERATION_DO: DurableObjectNamespace;

  // ---- Federation ----
  /** R2 key for the active PolicyBundle ("bundles/active.json"). */
  POLICY_BUNDLE_KEY?: string;
  /**
   * Base64-encoded Ed25519 raw public key (32 bytes) used to verify the
   * PolicyBundle signature. Required in staging/production; dev allows
   * unsigned bundles with a warning.
   */
  POLICY_BUNDLE_PUBKEY?: string;

  // ---- Egress / SSRF ----
  /**
   * Comma-separated hostname allow-list for manifest-supplied outbound URLs
   * (mcp_servers, peers). Hosts on this list bypass the private-host /
   * scheme checks. Use to explicitly permit internal-network targets.
   */
  SSRF_ALLOW_HOSTS?: string;

  // ---- Rate limiting ----
  /**
   * Cloudflare Rate Limiting binding (sliding-window). Keyed by tenant id
   * in `src/security/rate-limit.ts`. Optional: when the binding is absent
   * (unit tests, dev probes) the middleware soft-fails open.
   */
  TENANT_RATE_LIMIT?: RateLimit;

  // ---- At-rest encryption ----
  /**
   * Base64-encoded 32-byte AES-256 key used to encrypt the
   * `oauth_token_cache.access_token` column. Set via `wrangler secret put
   * OAUTH_CACHE_KEY`. Required in staging/production; dev falls back to
   * plaintext storage with a warning. Rotation is graceful — decryption
   * failures are treated as cache misses and a fresh token is fetched.
   */
  OAUTH_CACHE_KEY?: string;

  // ---- Queue consumer write-back ----
  /**
   * Shared secret required on the `POST /internal/sessions/:thread_id/events`
   * route, which queue consumers use to land asynchronous `tool_result`
   * events back on a session. Compared in constant time against the
   * `x-consumer-secret` request header. When unset (development), the
   * route refuses all requests — production deployments MUST configure
   * this secret on both Felix and the consumer Worker.
   */
  CONSUMER_SHARED_SECRET?: string;

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
   * Optional JWKS document (JSON) this worker serves at
   * `/.well-known/jwks.json`, making it a self-issued OIDC-style issuer. Set
   * alongside `JWT_VERIFIERS: "cognito https://<this-host>"` to verify tokens
   * minted with the matching private key (see `scripts/mint-jwt.ts`). Public
   * keys only. Used for staging write-testing without a third-party IdP.
   */
  JWKS_PUBLIC?: string;

  // ---- Env tag ----
  ENVIRONMENT: 'development' | 'staging' | 'production';
}

/**
 * `provider` is the registry key used to look up a `ModelProviderFactory`.
 * Built-ins are `anthropic`, `openai`, `workers-ai`; new providers register
 * via `registerModelProvider(...)`. Type is `string` (not a literal union)
 * to keep the registry open — `buildModel` resolves the factory at runtime
 * and raises a clear error listing registered providers when the name is
 * unknown.
 */
export interface ModelRoute {
  provider: string;
  model: string;
}

/**
 * Logical-model → upstream-provider routing baked into the bundle. Single
 * source of truth across dev/staging/production; an env may override via
 * the optional `MODEL_ROUTES` var (canary models, divergent regions).
 */
export const DEFAULT_MODEL_ROUTES: Record<string, ModelRoute> = {
  'claude-sonnet-4': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'claude-opus-4': { provider: 'anthropic', model: 'claude-opus-4-8' },
  'claude-haiku-4': { provider: 'anthropic', model: 'claude-haiku-4-5' },
  'llama-3-fast': { provider: 'workers-ai', model: '@cf/meta/llama-3.1-8b-instruct' },
  'llama-3-pro': { provider: 'workers-ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
};

export function parseModelRoutes(env: Env): Record<string, ModelRoute> {
  if (!env.MODEL_ROUTES) return DEFAULT_MODEL_ROUTES;
  try {
    return JSON.parse(env.MODEL_ROUTES);
  } catch {
    return DEFAULT_MODEL_ROUTES;
  }
}
