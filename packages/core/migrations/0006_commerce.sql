-- Orderloop commerce — catalog + orders.
--
-- Buyer-side conversational commerce on the Felix harness. Products are the
-- catalog source for the built-in `catalog_*` tools (the external catalog-MCP
-- path via spec.mcp_servers remains an alternative). Orders are written when a
-- Stripe Checkout Session completes (POST /commerce/stripe/webhook).
--
-- The cart is intentionally NOT a table here — it lives in the append-only
-- session log as the latest `kind: 'audit'`, `metadata.type: 'cart'` event,
-- so it travels with the thread and renders under every SessionStrategy.
--
-- Composite (tenant_id, id) primary keys + tenant-scoped indexes, matching the
-- rest of the schema. Always scope reads with WHERE tenant_id = ?.

CREATE TABLE IF NOT EXISTS products (
  tenant_id    TEXT NOT NULL,
  id           TEXT NOT NULL,              -- sku / product id
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price_cents  INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'usd',
  image_url    TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT '',
  inventory    INTEGER NOT NULL DEFAULT 0, -- -1 = unlimited
  active       INTEGER NOT NULL DEFAULT 1, -- 0/1 boolean
  attrs_json   TEXT NOT NULL DEFAULT '{}', -- size / color / etc.
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_products_tenant_category
  ON products (tenant_id, category, active);

CREATE TABLE IF NOT EXISTS orders (
  tenant_id    TEXT NOT NULL,
  id           TEXT NOT NULL,              -- order id
  thread_id    TEXT NOT NULL DEFAULT '',   -- session thread the cart came from
  stripe_ref   TEXT NOT NULL DEFAULT '',   -- Stripe Checkout Session / PaymentIntent id
  total_cents  INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'usd',
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | paid | fulfilled | cancelled
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_orders_tenant_created
  ON orders (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_tenant_stripe
  ON orders (tenant_id, stripe_ref);

CREATE TABLE IF NOT EXISTS order_items (
  tenant_id    TEXT NOT NULL,
  order_id     TEXT NOT NULL,
  product_id   TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  qty          INTEGER NOT NULL,
  price_cents  INTEGER NOT NULL,           -- snapshot at purchase time
  PRIMARY KEY (tenant_id, order_id, product_id)
);
