-- Postgres baseline for Felix — collapses D1 migrations 0001–0022 at their
-- net shapes (fresh-start cutover; no data migrated from D1).
--
-- Dialect conventions (differ from the old SQLite schema):
--   - timestamps stay epoch-ms but as BIGINT (code uses Date.now() throughout;
--     the getDb client parses int8 → Number)
--   - 0/1 INTEGER booleans become real BOOLEAN
--   - *_json TEXT blobs become JSONB (queried with ->> instead of json_extract)
--
-- Unchanged conventions: tenant-first composite primary keys, tenant-scoped
-- (tenant_id, ts DESC) indexes, every read WHERE tenant_id = $1. brand_domains
-- stays host-keyed by design (global storefront routing).
--
-- Applied with node-pg-migrate over a DIRECT (unpooled) connection — never
-- through Hyperdrive (transaction-mode pooling + caching are wrong for DDL).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Harness core
-- ---------------------------------------------------------------------------

CREATE TABLE audit_events (
  id              text NOT NULL,
  tenant_id       text NOT NULL,
  ts              bigint NOT NULL,
  event_type      text NOT NULL,
  manifest_id     text NOT NULL DEFAULT '',
  principal_subj  text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT '',
  payload_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_audit_tenant_ts ON audit_events (tenant_id, ts DESC);
CREATE INDEX idx_audit_tenant_status_ts ON audit_events (tenant_id, status, ts DESC);
-- Global (tenant-agnostic) retention sweep scans WHERE ts < cutoff.
CREATE INDEX idx_audit_ts ON audit_events (ts);

CREATE TABLE plans (
  id              text NOT NULL,
  tenant_id       text NOT NULL,
  manifest_id     text NOT NULL DEFAULT '',
  created_at      bigint NOT NULL,
  updated_at      bigint NOT NULL,
  expires_at      bigint,                    -- TTL — null = no expiry
  plan_json       jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_plans_tenant_updated ON plans (tenant_id, updated_at DESC);
-- Retention sweep prunes by absolute expires_at; partial index skips the
-- common null-TTL rows so it only covers deletable rows.
CREATE INDEX idx_plans_expires ON plans (expires_at) WHERE expires_at IS NOT NULL;

-- Net shape from D1 0002_harden: tenant-scoped PK closes the cross-tenant
-- job listing leak. (The PK covers (tenant_id, name) lookups; the old
-- redundant idx_jobs_tenant_name is intentionally dropped.)
CREATE TABLE jobs (
  tenant_id       text NOT NULL,
  name            text NOT NULL,
  schedule        text NOT NULL DEFAULT '',
  manifest_id     text NOT NULL DEFAULT '',
  last_run_at     bigint,
  next_run_at     bigint,
  last_status     text NOT NULL DEFAULT '',
  last_error      text NOT NULL DEFAULT '',
  created_at      bigint NOT NULL,
  payload_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, name)
);
CREATE INDEX idx_jobs_next_run ON jobs (next_run_at)
  WHERE schedule != '' AND next_run_at IS NOT NULL;

CREATE TABLE approvals (
  id                text NOT NULL,
  tenant_id         text NOT NULL,
  manifest_id       text NOT NULL DEFAULT '',
  tool_name         text NOT NULL,
  call_signature    text NOT NULL,
  args_json         jsonb NOT NULL DEFAULT '{}'::jsonb,
  principal_subj    text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'pending',
  created_at        bigint NOT NULL,
  decided_at        bigint,
  decided_by        text NOT NULL DEFAULT '',
  decision_note     text NOT NULL DEFAULT '',
  edited_args_json  jsonb,
  -- 0019_approvals_ttl: grant expiry. ttl_seconds is stamped at request
  -- creation; expires_at is computed at DECIDE time (decided_at + ttl*1000).
  ttl_seconds       integer,
  expires_at        bigint,
  PRIMARY KEY (tenant_id, id)
);
-- Partial unique index over live decisions only: terminal archived states
-- (consumed / expired) stop blocking a fresh request for the same signature
-- while live decisions stay unique (idempotency + sticky-denied contract).
CREATE UNIQUE INDEX uq_approval_signature
  ON approvals (tenant_id, manifest_id, tool_name, call_signature)
  WHERE status IN ('pending', 'approved', 'denied');
CREATE INDEX idx_approvals_tenant_status ON approvals (tenant_id, status, created_at DESC);

CREATE TABLE skill_activation (
  tenant_id       text NOT NULL,
  manifest_id     text NOT NULL,
  active_skills   jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at      bigint NOT NULL,
  PRIMARY KEY (tenant_id, manifest_id)
);

CREATE TABLE oauth_token_cache (
  cache_key       text PRIMARY KEY,            -- provider:subject
  access_token    text NOT NULL,               -- AES-256-GCM at rest (OAUTH_CACHE_KEY)
  expires_at      bigint NOT NULL,
  scope           text NOT NULL DEFAULT ''
);

CREATE TABLE manifests (
  tenant_id      text NOT NULL,
  name           text NOT NULL,
  version        integer NOT NULL,            -- monotonic per (tenant_id, name)
  manifest_json  jsonb NOT NULL,
  created_at     bigint NOT NULL,
  created_by     text NOT NULL DEFAULT '',
  comment        text NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, name, version)
);
CREATE INDEX idx_manifests_tenant_name_created
  ON manifests (tenant_id, name, created_at DESC);

CREATE TABLE manifest_active (
  tenant_id       text NOT NULL,
  name            text NOT NULL,
  version         integer NOT NULL,
  updated_at      bigint NOT NULL,
  updated_by      text NOT NULL DEFAULT '',
  -- 0005_manifest_canary. The 0..100 bound was store-enforced on SQLite
  -- (no ALTER ... ADD CHECK there); Postgres enforces it at the schema too.
  canary_version  integer,
  canary_weight   integer NOT NULL DEFAULT 0
    CHECK (canary_weight BETWEEN 0 AND 100),
  PRIMARY KEY (tenant_id, name)
);
CREATE INDEX idx_manifest_active_tenant_updated
  ON manifest_active (tenant_id, updated_at DESC);

CREATE TABLE eval_datasets (
  tenant_id     text NOT NULL,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  created_at    bigint NOT NULL,
  PRIMARY KEY (tenant_id, name)
);
CREATE INDEX idx_eval_datasets_tenant_created
  ON eval_datasets (tenant_id, created_at DESC);

CREATE TABLE eval_dataset_items (
  tenant_id     text NOT NULL,
  dataset_name  text NOT NULL,
  item_id       text NOT NULL,
  user_input    text NOT NULL,
  rubric_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    bigint NOT NULL,
  PRIMARY KEY (tenant_id, dataset_name, item_id)
);
CREATE INDEX idx_eval_items_tenant_dataset
  ON eval_dataset_items (tenant_id, dataset_name, created_at);

CREATE TABLE eval_runs (
  tenant_id            text NOT NULL,
  id                   text NOT NULL,
  dataset_name         text NOT NULL,
  candidate_manifest   text NOT NULL,
  started_at           bigint NOT NULL,
  finished_at          bigint,
  status               text NOT NULL DEFAULT 'in_progress',
  pass_count           integer NOT NULL DEFAULT 0,
  fail_count           integer NOT NULL DEFAULT 0,
  scores_json          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 0022_eval_gate: tenant-managed version the run tested; NULL for runs
  -- against bundled/R2 manifests (those can never satisfy the gate).
  manifest_version     integer,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_eval_runs_tenant_started
  ON eval_runs (tenant_id, started_at DESC);
CREATE INDEX idx_eval_runs_tenant_dataset
  ON eval_runs (tenant_id, dataset_name, started_at DESC);
CREATE INDEX idx_eval_runs_gate
  ON eval_runs (tenant_id, candidate_manifest, manifest_version, started_at DESC);

-- ---------------------------------------------------------------------------
-- Vector memory (replaces the Vectorize MEMORY_VEC index)
-- ---------------------------------------------------------------------------
-- One table for every 768-dim BGE embedding the harness + plugins store:
-- semantic memory (fact/preference/episode), procedural memory, and the
-- commerce product / product-image embeddings. Scope filters that used to be
-- Vectorize metadata ({tenant, manifest, kind}) are real columns.

CREATE TABLE memory_vectors (
  tenant_id   text NOT NULL,
  id          text NOT NULL,
  kind        text NOT NULL,                  -- fact|preference|episode|procedural|product|product_image
  manifest_id text NOT NULL DEFAULT '',
  embedding   vector(768) NOT NULL,           -- Workers AI BGE, unchanged
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
-- Cosine ANN. HNSW post-filters WHERE clauses, which can under-fill topK for
-- tiny tenants — acceptable at Felix scale (see plan/docs).
CREATE INDEX idx_memvec_hnsw ON memory_vectors USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_memvec_scope ON memory_vectors (tenant_id, kind, manifest_id);

-- ---------------------------------------------------------------------------
-- Commerce (@felix/commerce)
-- ---------------------------------------------------------------------------

CREATE TABLE products (
  tenant_id    text NOT NULL,
  id           text NOT NULL,                 -- sku / product id
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  price_cents  integer NOT NULL,
  currency     text NOT NULL DEFAULT 'usd',
  image_url    text NOT NULL DEFAULT '',
  category     text NOT NULL DEFAULT '',
  inventory    integer NOT NULL DEFAULT 0,    -- -1 = unlimited
  active       boolean NOT NULL DEFAULT true,
  attrs_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   bigint NOT NULL,
  -- Full-text search over the catalog (D1 could only LIKE-scan). Weighted:
  -- title > category > description; paired with a trigram index on title for
  -- typo'd single-word queries.
  search_tsv   tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) STORED,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_products_tenant_category ON products (tenant_id, category, active);
CREATE INDEX idx_products_tsv ON products USING gin (search_tsv);
CREATE INDEX idx_products_trgm ON products USING gin (title gin_trgm_ops);

CREATE TABLE orders (
  tenant_id    text NOT NULL,
  id           text NOT NULL,
  thread_id    text NOT NULL DEFAULT '',
  stripe_ref   text NOT NULL DEFAULT '',
  total_cents  integer NOT NULL,
  currency     text NOT NULL DEFAULT 'usd',
  status       text NOT NULL DEFAULT 'pending', -- pending | paid | fulfilled | cancelled
  created_at   bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_orders_tenant_created ON orders (tenant_id, created_at DESC);
CREATE INDEX idx_orders_tenant_stripe ON orders (tenant_id, stripe_ref);

CREATE TABLE order_items (
  tenant_id    text NOT NULL,
  order_id     text NOT NULL,
  product_id   text NOT NULL,
  title        text NOT NULL DEFAULT '',
  qty          integer NOT NULL,
  price_cents  integer NOT NULL,              -- snapshot at purchase time
  PRIMARY KEY (tenant_id, order_id, product_id)
);

CREATE TABLE acp_checkout_sessions (
  tenant_id     text NOT NULL,
  id            text NOT NULL,                -- checkout_session id (acp_...)
  status        text NOT NULL,                -- ACP status enum
  session_json  jsonb NOT NULL,               -- full CheckoutSession JSON
  order_id      text NOT NULL DEFAULT '',
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_acp_sessions_tenant_updated
  ON acp_checkout_sessions (tenant_id, updated_at DESC);

CREATE TABLE brands (
  tenant_id     text NOT NULL,                -- operator/platform tenant (owner)
  id            text NOT NULL,                -- brand slug
  brand_tenant  text NOT NULL,                -- data tenant for catalog/orders/manifest
  name          text NOT NULL,
  identity_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'active', -- active | disabled
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_brands_tenant_created ON brands (tenant_id, created_at DESC);
CREATE INDEX idx_brands_brand_tenant ON brands (brand_tenant);

-- Host-keyed by design: one host → one brand, public storefront routing with
-- no tenant filter (see D1 0009).
CREATE TABLE brand_domains (
  host             text PRIMARY KEY,          -- lowercased hostname
  brand_tenant     text NOT NULL,
  brand_id         text NOT NULL,
  operator_tenant  text NOT NULL,
  created_at       bigint NOT NULL
);
CREATE INDEX idx_brand_domains_brand_tenant ON brand_domains (brand_tenant);

CREATE TABLE data_sources (
  tenant_id      text NOT NULL,
  entity_type    text NOT NULL,               -- 'account' | 'buyer' | 'product' | …
  mode           text NOT NULL DEFAULT 'native',
  connector_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at     bigint NOT NULL,
  updated_by     text NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, entity_type)
);

CREATE TABLE accounts (
  tenant_id          text NOT NULL,
  id                 text NOT NULL,
  name               text NOT NULL,
  status             text NOT NULL DEFAULT 'active',   -- active | suspended
  payment_terms      text NOT NULL DEFAULT 'prepaid',  -- prepaid | net15 | net30 | net60
  credit_limit_cents integer NOT NULL DEFAULT 0,       -- 0 = no credit line
  currency           text NOT NULL DEFAULT 'usd',
  metadata_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_accounts_tenant_created ON accounts (tenant_id, created_at DESC);

CREATE TABLE buyers (
  tenant_id            text NOT NULL,
  id                   text NOT NULL,          -- buyer id (subject/email)
  account_id           text NOT NULL,
  email                text NOT NULL DEFAULT '',
  role                 text NOT NULL DEFAULT 'purchaser', -- admin | approver | purchaser | viewer
  spending_limit_cents integer NOT NULL DEFAULT 0,        -- 0 = unlimited
  status               text NOT NULL DEFAULT 'active',    -- active | disabled
  created_at           bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_buyers_tenant_account ON buyers (tenant_id, account_id);

CREATE TABLE quotes (
  tenant_id      text NOT NULL,
  id             text NOT NULL,
  account_id     text NOT NULL,
  buyer_id       text NOT NULL,
  status         text NOT NULL DEFAULT 'draft',
  currency       text NOT NULL DEFAULT 'usd',
  subtotal_cents integer NOT NULL DEFAULT 0,
  discount_cents integer NOT NULL DEFAULT 0,
  total_cents    integer NOT NULL DEFAULT 0,
  valid_until    bigint,                       -- null until sent
  approval_id    text NOT NULL DEFAULT '',
  order_id       text NOT NULL DEFAULT '',
  notes          text NOT NULL DEFAULT '',
  created_at     bigint NOT NULL,
  updated_at     bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_quotes_tenant_account ON quotes (tenant_id, account_id, created_at DESC);

CREATE TABLE quote_items (
  tenant_id        text NOT NULL,
  quote_id         text NOT NULL,
  product_id       text NOT NULL,
  title            text NOT NULL DEFAULT '',
  qty              integer NOT NULL,
  unit_price_cents integer NOT NULL,
  discount_cents   integer NOT NULL DEFAULT 0,
  line_total_cents integer NOT NULL,
  PRIMARY KEY (tenant_id, quote_id, product_id)
);

-- Net shape includes the 0014_billing provider columns.
CREATE TABLE invoices (
  tenant_id    text NOT NULL,
  id           text NOT NULL,
  account_id   text NOT NULL,
  quote_id     text NOT NULL DEFAULT '',
  order_id     text NOT NULL DEFAULT '',
  amount_cents integer NOT NULL,
  currency     text NOT NULL DEFAULT 'usd',
  terms        text NOT NULL DEFAULT 'prepaid',
  status       text NOT NULL DEFAULT 'open',  -- open | paid | void
  due_at       bigint NOT NULL,
  created_at   bigint NOT NULL,
  paid_at      bigint,
  provider     text NOT NULL DEFAULT 'internal',
  external_ref text NOT NULL DEFAULT '',
  hosted_url   text NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_invoices_tenant_account ON invoices (tenant_id, account_id, created_at DESC);

CREATE TABLE contract_prices (
  tenant_id   text NOT NULL,
  account_id  text NOT NULL,
  product_id  text NOT NULL,
  currency    text NOT NULL DEFAULT 'usd',
  tiers_json  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  bigint NOT NULL,
  updated_at  bigint NOT NULL,
  PRIMARY KEY (tenant_id, account_id, product_id)
);
CREATE INDEX idx_contract_prices_tenant_account ON contract_prices (tenant_id, account_id);

CREATE TABLE billing_settings (
  tenant_id    text NOT NULL,
  provider     text NOT NULL DEFAULT 'internal', -- internal | stripe | …
  config_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at   bigint NOT NULL,
  updated_by   text NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id)
);

CREATE TABLE geo_queries (
  tenant_id   text NOT NULL,
  id          text NOT NULL,
  brand_id    text NOT NULL DEFAULT '',
  query_text  text NOT NULL,
  engine      text NOT NULL DEFAULT 'workers_ai',
  active      boolean NOT NULL DEFAULT true,  -- soft disable without deleting history
  created_at  bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_geo_queries_active ON geo_queries (active, tenant_id);

CREATE TABLE geo_observations (
  tenant_id        text NOT NULL,
  id               text NOT NULL,
  query_id         text NOT NULL,
  brand_id         text NOT NULL DEFAULT '',
  engine           text NOT NULL DEFAULT '',
  ts               bigint NOT NULL,
  brand_mentioned  boolean NOT NULL DEFAULT false,
  rank             integer NOT NULL DEFAULT 0, -- 1-based position; 0 = absent
  competitors_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  products_json    jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer_excerpt   text NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_geo_obs_query_ts ON geo_observations (tenant_id, query_id, ts DESC);
CREATE INDEX idx_geo_obs_brand_ts ON geo_observations (tenant_id, brand_id, ts DESC);

CREATE TABLE consents (
  tenant_id     text NOT NULL,
  id            text NOT NULL,
  subject       text NOT NULL DEFAULT '',
  thread_id     text NOT NULL DEFAULT '',
  channel       text NOT NULL DEFAULT '',      -- chat | acp | b2b | widget
  scopes_json   jsonb NOT NULL DEFAULT '[]'::jsonb,
  granted       boolean NOT NULL DEFAULT false, -- withdrawal = new row, never UPDATE
  terms_version text NOT NULL DEFAULT '',
  policy_url    text NOT NULL DEFAULT '',
  created_at    bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_consents_thread ON consents (tenant_id, thread_id, created_at DESC);
CREATE INDEX idx_consents_subject ON consents (tenant_id, subject, created_at DESC);

CREATE TABLE order_attribution (
  tenant_id     text NOT NULL,
  order_id      text NOT NULL,
  channel       text NOT NULL DEFAULT '',
  manifest_id   text NOT NULL DEFAULT '',
  thread_id     text NOT NULL DEFAULT '',
  buyer_subject text NOT NULL DEFAULT '',
  consent_id    text NOT NULL DEFAULT '',
  utm_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    bigint NOT NULL,
  PRIMARY KEY (tenant_id, order_id)
);
CREATE INDEX idx_attribution_channel ON order_attribution (tenant_id, channel, created_at DESC);
CREATE INDEX idx_attribution_manifest ON order_attribution (tenant_id, manifest_id, created_at DESC);

CREATE TABLE customers (
  tenant_id    text NOT NULL,
  id           text NOT NULL,
  email        text NOT NULL DEFAULT '',
  external_ref text NOT NULL DEFAULT '',
  attrs_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   bigint NOT NULL,
  last_seen_at bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_customers_tenant_email ON customers (tenant_id, email);

CREATE TABLE customer_sessions (
  tenant_id   text NOT NULL,
  thread_id   text NOT NULL,
  customer_id text NOT NULL,
  created_at  bigint NOT NULL,
  PRIMARY KEY (tenant_id, thread_id)
);
CREATE INDEX idx_customer_sessions_customer ON customer_sessions (tenant_id, customer_id);

CREATE TABLE behavior_events (
  tenant_id     text NOT NULL,
  id            text NOT NULL,
  customer_id   text NOT NULL DEFAULT '',
  thread_id     text NOT NULL DEFAULT '',
  type          text NOT NULL,                -- view | add_to_cart | remove | checkout_start | purchase
  product_id    text NOT NULL DEFAULT '',
  ts            bigint NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_behavior_tenant_ts ON behavior_events (tenant_id, ts DESC);
CREATE INDEX idx_behavior_tenant_thread_ts ON behavior_events (tenant_id, thread_id, ts DESC);
CREATE INDEX idx_behavior_tenant_customer_ts ON behavior_events (tenant_id, customer_id, ts DESC);

CREATE TABLE abandoned_carts (
  tenant_id   text NOT NULL,
  thread_id   text NOT NULL,
  customer_id text NOT NULL DEFAULT '',
  detected_at bigint NOT NULL,
  notified_at bigint NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'open',   -- open | recovered | dismissed
  PRIMARY KEY (tenant_id, thread_id)
);
CREATE INDEX idx_abandoned_tenant_detected ON abandoned_carts (tenant_id, detected_at DESC);

CREATE TABLE pricing_rules (
  tenant_id      text NOT NULL,
  id             text NOT NULL,
  scope          text NOT NULL DEFAULT 'catalog', -- catalog | category | product
  target         text NOT NULL DEFAULT '',
  kind           text NOT NULL,                   -- time | velocity | competitor
  adjustment_bps integer NOT NULL DEFAULT 0,
  config_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  active         boolean NOT NULL DEFAULT true,
  created_at     bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_pricing_rules_tenant_active ON pricing_rules (tenant_id, active);

CREATE TABLE competitor_prices (
  tenant_id   text NOT NULL,
  id          text NOT NULL,                  -- "<product_id>:<source>"
  product_id  text NOT NULL,
  source      text NOT NULL DEFAULT '',
  price_cents integer NOT NULL,
  currency    text NOT NULL DEFAULT 'usd',
  observed_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_competitor_prices_tenant_product ON competitor_prices (tenant_id, product_id);
