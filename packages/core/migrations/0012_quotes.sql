-- Orderloop B2B — quote-to-cash.
--
-- RFQ → quote → accept → order → invoice (net terms). A quote belongs to an
-- account + buyer, carries priced line items + totals (integer cents), and a
-- validity window. Acceptance runs purchase authority; over-limit accepts route
-- to an approver (approval_id) and sit in `pending_approval` until decided.
-- Convert creates an order (reusing the `orders` table) + an invoice whose
-- due date is derived from the account's payment terms.
--
-- Quotes + invoices are also registered on the entity data-source seam, so a
-- tenant on an external CPQ/billing system can back them federated/synced.

CREATE TABLE IF NOT EXISTS quotes (
  tenant_id      TEXT NOT NULL,
  id             TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  buyer_id       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft', -- draft|sent|accepted|pending_approval|ordered|rejected|expired|cancelled
  currency       TEXT NOT NULL DEFAULT 'usd',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents    INTEGER NOT NULL DEFAULT 0,
  valid_until    INTEGER,                       -- ms epoch; null until sent
  approval_id    TEXT NOT NULL DEFAULT '',
  order_id       TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_quotes_tenant_account
  ON quotes (tenant_id, account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS quote_items (
  tenant_id        TEXT NOT NULL,
  quote_id         TEXT NOT NULL,
  product_id       TEXT NOT NULL,
  title            TEXT NOT NULL DEFAULT '',
  qty              INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  discount_cents   INTEGER NOT NULL DEFAULT 0, -- line-level absolute discount
  line_total_cents INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, quote_id, product_id)
);

CREATE TABLE IF NOT EXISTS invoices (
  tenant_id   TEXT NOT NULL,
  id          TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  quote_id    TEXT NOT NULL DEFAULT '',
  order_id    TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'usd',
  terms       TEXT NOT NULL DEFAULT 'prepaid',
  status      TEXT NOT NULL DEFAULT 'open',   -- open | paid | void
  due_at      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  paid_at     INTEGER,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_account
  ON invoices (tenant_id, account_id, created_at DESC);
