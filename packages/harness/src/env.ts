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
   * Optional retention window (in days) for the `retention_sweep` cron
   * (`jobs/retention.ts`). Audit events older than this are pruned each
   * tick. Parsed defensively by `parseAuditRetentionDays`: unset/non-numeric
   * → default 90; valid values are floored and clamped to `[7, 3650]`.
   */
  AUDIT_RETENTION_DAYS?: string;
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
   * whitespace-separated `<scheme> <issuer> [audience] [tenant=<directive>]`
   * where scheme is `access` (Cloudflare Access) or `cognito` (standard OIDC
   * JWKS path). `audience` is required for `cognito` outside development
   * (unless self-issuing via JWKS_PUBLIC); the optional `tenant=` field pins
   * how the verifier maps a token to a tenant (`tenant=<id>` fixed,
   * `tenant=issuer`, `tenant=claim`). See `parseVerifiers` in `auth/jwt.ts`.
   * Empty string = no verifiers.
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

  // Commerce env vars (STRIPE_*, COMMERCE_*, ACP_*, BILLING_PROVIDER_DEFAULT,
  // GEO_MONITOR) are contributed by the commerce plugin via module
  // augmentation — see `src/commerce/env.ts`.

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
