/**
 * Quote + invoice native stores (D1) + entity-seam registration. Quotes carry
 * their line items (quote_items); upsert replaces the item set transactionally.
 * Registered as `quote` / `invoice` entity types so a tenant on an external
 * CPQ/billing system can back them federated/synced.
 */

import { registerEntityType } from '../../entities/registry';
import type { ListOpts, NativeStore, Page, RawRecord } from '../../entities/types';
import type { Env } from '../../env';
import { Invoice, Quote, type QuoteItem } from './quote-models';

// ---- quotes ----

interface QuoteRow {
  tenant_id: string;
  id: string;
  account_id: string;
  buyer_id: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  valid_until: number | null;
  approval_id: string;
  order_id: string;
  notes: string;
  created_at: number;
  updated_at: number;
}

interface QuoteItemRow {
  product_id: string;
  title: string;
  qty: number;
  unit_price_cents: number;
  discount_cents: number;
  line_total_cents: number;
}

function rowToQuote(row: QuoteRow, items: QuoteItem[]): Quote {
  return Quote.parse({
    tenant_id: row.tenant_id,
    id: row.id,
    account_id: row.account_id,
    buyer_id: row.buyer_id,
    status: row.status,
    currency: row.currency,
    subtotal_cents: row.subtotal_cents,
    discount_cents: row.discount_cents,
    total_cents: row.total_cents,
    valid_until: row.valid_until,
    approval_id: row.approval_id,
    order_id: row.order_id,
    notes: row.notes,
    items,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

async function readItems(env: Env, tenant: string, quoteId: string): Promise<QuoteItem[]> {
  const rows = await env.DB.prepare(
    'SELECT product_id, title, qty, unit_price_cents, discount_cents, line_total_cents FROM quote_items WHERE tenant_id = ? AND quote_id = ?',
  )
    .bind(tenant, quoteId)
    .all<QuoteItemRow>();
  return (rows.results ?? []).map((r) => ({ ...r }));
}

export const quoteStore: NativeStore<Quote> = {
  async get(env, tenant, id) {
    const row = await env.DB.prepare('SELECT * FROM quotes WHERE tenant_id = ? AND id = ? LIMIT 1')
      .bind(tenant, id)
      .first<QuoteRow>();
    if (!row) return null;
    return rowToQuote(row, await readItems(env, tenant, id));
  },
  async list(env, tenant, opts?: ListOpts): Promise<Page<Quote>> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const rows = await env.DB.prepare(
      'SELECT * FROM quotes WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
    )
      .bind(tenant, limit)
      .all<QuoteRow>();
    // List view omits items to avoid N+1; callers fetch a single quote for items.
    return { items: (rows.results ?? []).map((r) => rowToQuote(r, [])) };
  },
  async upsert(env, tenant, q) {
    const stmts = [
      env.DB.prepare(
        `INSERT INTO quotes (tenant_id, id, account_id, buyer_id, status, currency, subtotal_cents,
                             discount_cents, total_cents, valid_until, approval_id, order_id, notes,
                             created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           status = excluded.status, currency = excluded.currency, subtotal_cents = excluded.subtotal_cents,
           discount_cents = excluded.discount_cents, total_cents = excluded.total_cents,
           valid_until = excluded.valid_until, approval_id = excluded.approval_id,
           order_id = excluded.order_id, notes = excluded.notes, updated_at = excluded.updated_at`,
      ).bind(
        tenant,
        q.id,
        q.account_id,
        q.buyer_id,
        q.status,
        q.currency,
        q.subtotal_cents,
        q.discount_cents,
        q.total_cents,
        q.valid_until,
        q.approval_id,
        q.order_id,
        q.notes,
        q.created_at,
        q.updated_at,
      ),
      env.DB.prepare('DELETE FROM quote_items WHERE tenant_id = ? AND quote_id = ?').bind(
        tenant,
        q.id,
      ),
      ...q.items.map((it) =>
        env.DB.prepare(
          `INSERT INTO quote_items (tenant_id, quote_id, product_id, title, qty, unit_price_cents, discount_cents, line_total_cents)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          tenant,
          q.id,
          it.product_id,
          it.title,
          it.qty,
          it.unit_price_cents,
          it.discount_cents,
          it.line_total_cents,
        ),
      ),
    ];
    await env.DB.batch(stmts);
  },
};

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

export function mapQuote(raw: RawRecord, tenant: string): Quote {
  const items = Array.isArray(raw.items) ? (raw.items as QuoteItem[]) : [];
  return Quote.parse({
    tenant_id: tenant,
    id: str(raw.id) || 'unknown',
    account_id: str(raw.account_id),
    buyer_id: str(raw.buyer_id),
    status: str(raw.status, 'draft'),
    currency: str(raw.currency, 'usd'),
    subtotal_cents: num(raw.subtotal_cents),
    discount_cents: num(raw.discount_cents),
    total_cents: num(raw.total_cents),
    valid_until: typeof raw.valid_until === 'number' ? raw.valid_until : null,
    approval_id: str(raw.approval_id),
    order_id: str(raw.order_id),
    notes: str(raw.notes),
    items,
    created_at: num(raw.created_at),
    updated_at: num(raw.updated_at),
  });
}

export async function listQuotesByAccount(
  env: Env,
  tenant: string,
  accountId: string,
): Promise<Quote[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM quotes WHERE tenant_id = ? AND account_id = ? ORDER BY created_at DESC',
  )
    .bind(tenant, accountId)
    .all<QuoteRow>();
  return (rows.results ?? []).map((r) => rowToQuote(r, []));
}

// ---- invoices ----

interface InvoiceRow {
  tenant_id: string;
  id: string;
  account_id: string;
  quote_id: string;
  order_id: string;
  amount_cents: number;
  currency: string;
  terms: string;
  status: string;
  due_at: number;
  created_at: number;
  paid_at: number | null;
  provider: string;
  external_ref: string;
  hosted_url: string;
}

function rowToInvoice(r: InvoiceRow): Invoice {
  return Invoice.parse({ ...r });
}

export const invoiceStore: NativeStore<Invoice> = {
  async get(env, tenant, id) {
    const row = await env.DB.prepare(
      'SELECT * FROM invoices WHERE tenant_id = ? AND id = ? LIMIT 1',
    )
      .bind(tenant, id)
      .first<InvoiceRow>();
    return row ? rowToInvoice(row) : null;
  },
  async list(env, tenant, opts?: ListOpts): Promise<Page<Invoice>> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const rows = await env.DB.prepare(
      'SELECT * FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
    )
      .bind(tenant, limit)
      .all<InvoiceRow>();
    return { items: (rows.results ?? []).map(rowToInvoice) };
  },
  async upsert(env, tenant, inv) {
    await env.DB.prepare(
      `INSERT INTO invoices (tenant_id, id, account_id, quote_id, order_id, amount_cents, currency,
                             terms, status, due_at, created_at, paid_at, provider, external_ref, hosted_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         status = excluded.status, paid_at = excluded.paid_at,
         provider = excluded.provider, external_ref = excluded.external_ref,
         hosted_url = excluded.hosted_url`,
    )
      .bind(
        tenant,
        inv.id,
        inv.account_id,
        inv.quote_id,
        inv.order_id,
        inv.amount_cents,
        inv.currency,
        inv.terms,
        inv.status,
        inv.due_at,
        inv.created_at,
        inv.paid_at,
        inv.provider,
        inv.external_ref,
        inv.hosted_url,
      )
      .run();
  },
};

export function mapInvoice(raw: RawRecord, tenant: string): Invoice {
  return Invoice.parse({
    tenant_id: tenant,
    id: str(raw.id) || 'unknown',
    account_id: str(raw.account_id),
    quote_id: str(raw.quote_id),
    order_id: str(raw.order_id),
    amount_cents: num(raw.amount_cents),
    currency: str(raw.currency, 'usd'),
    terms: str(raw.terms, 'prepaid'),
    status: str(raw.status, 'open'),
    due_at: num(raw.due_at),
    created_at: num(raw.created_at),
    paid_at: typeof raw.paid_at === 'number' ? raw.paid_at : null,
  });
}

registerEntityType<Quote>({ type: 'quote', native: quoteStore, mapper: mapQuote });
registerEntityType<Invoice>({ type: 'invoice', native: invoiceStore, mapper: mapInvoice });
