/**
 * B2B native stores (D1) + external mappers + entity-type registration.
 *
 * `accountStore` / `buyerStore` implement the seam's `NativeStore<T>` so they
 * back `native` and `synced` modes; the `mapAccount` / `mapBuyer` mappers turn
 * a connector's raw record into a typed entity for `federated`/`synced`. The
 * `registerEntityType` calls at the bottom wire both into the resolver + sync.
 */

import type { Env } from '@felix/harness/env';
import { registerEntityType } from '../entities/registry';
import type { ListOpts, NativeStore, Page, RawRecord } from '../entities/types';
import { Account, Buyer } from './models';

// ---- accounts ----

interface AccountRow {
  tenant_id: string;
  id: string;
  name: string;
  status: string;
  payment_terms: string;
  credit_limit_cents: number;
  currency: string;
  metadata_json: string;
  created_at: number;
}

function rowToAccount(r: AccountRow): Account {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(r.metadata_json);
  } catch {
    /* default */
  }
  return Account.parse({
    tenant_id: r.tenant_id,
    id: r.id,
    name: r.name,
    status: r.status,
    payment_terms: r.payment_terms,
    credit_limit_cents: r.credit_limit_cents,
    currency: r.currency,
    metadata,
    created_at: r.created_at,
  });
}

export const accountStore: NativeStore<Account> = {
  async get(env, tenant, id) {
    const row = await env.DB.prepare(
      'SELECT * FROM accounts WHERE tenant_id = ? AND id = ? LIMIT 1',
    )
      .bind(tenant, id)
      .first<AccountRow>();
    return row ? rowToAccount(row) : null;
  },
  async list(env, tenant, opts?: ListOpts): Promise<Page<Account>> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const rows = await env.DB.prepare(
      'SELECT * FROM accounts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
    )
      .bind(tenant, limit)
      .all<AccountRow>();
    return { items: (rows.results ?? []).map(rowToAccount) };
  },
  async upsert(env, tenant, a) {
    await env.DB.prepare(
      `INSERT INTO accounts (tenant_id, id, name, status, payment_terms, credit_limit_cents, currency, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         name = excluded.name, status = excluded.status, payment_terms = excluded.payment_terms,
         credit_limit_cents = excluded.credit_limit_cents, currency = excluded.currency,
         metadata_json = excluded.metadata_json`,
    )
      .bind(
        tenant,
        a.id,
        a.name,
        a.status,
        a.payment_terms,
        a.credit_limit_cents,
        a.currency,
        JSON.stringify(a.metadata),
        a.created_at,
      )
      .run();
  },
};

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

/** Map an external raw record into an Account (tolerant of field names). */
export function mapAccount(raw: RawRecord, tenant: string): Account {
  return Account.parse({
    tenant_id: tenant,
    id: str(raw.id ?? raw.account_id ?? raw.number) || 'unknown',
    name: str(raw.name ?? raw.company_name, 'Unnamed account'),
    status: raw.status === 'suspended' ? 'suspended' : 'active',
    payment_terms: str(raw.payment_terms, 'prepaid'),
    credit_limit_cents: num(raw.credit_limit_cents ?? raw.credit_limit),
    currency: str(raw.currency, 'usd'),
    metadata: (raw.metadata as Record<string, unknown>) ?? {},
    created_at: num(raw.created_at, 0),
  });
}

export async function deleteAccount(env: Env, tenant: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM accounts WHERE tenant_id = ? AND id = ?')
    .bind(tenant, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---- buyers ----

interface BuyerRow {
  tenant_id: string;
  id: string;
  account_id: string;
  email: string;
  role: string;
  spending_limit_cents: number;
  status: string;
  created_at: number;
}

function rowToBuyer(r: BuyerRow): Buyer {
  return Buyer.parse({
    tenant_id: r.tenant_id,
    id: r.id,
    account_id: r.account_id,
    email: r.email,
    role: r.role,
    spending_limit_cents: r.spending_limit_cents,
    status: r.status,
    created_at: r.created_at,
  });
}

export const buyerStore: NativeStore<Buyer> = {
  async get(env, tenant, id) {
    const row = await env.DB.prepare('SELECT * FROM buyers WHERE tenant_id = ? AND id = ? LIMIT 1')
      .bind(tenant, id)
      .first<BuyerRow>();
    return row ? rowToBuyer(row) : null;
  },
  async list(env, tenant, opts?: ListOpts): Promise<Page<Buyer>> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const rows = await env.DB.prepare(
      'SELECT * FROM buyers WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
    )
      .bind(tenant, limit)
      .all<BuyerRow>();
    return { items: (rows.results ?? []).map(rowToBuyer) };
  },
  async upsert(env, tenant, b) {
    await env.DB.prepare(
      `INSERT INTO buyers (tenant_id, id, account_id, email, role, spending_limit_cents, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         account_id = excluded.account_id, email = excluded.email, role = excluded.role,
         spending_limit_cents = excluded.spending_limit_cents, status = excluded.status`,
    )
      .bind(
        tenant,
        b.id,
        b.account_id,
        b.email,
        b.role,
        b.spending_limit_cents,
        b.status,
        b.created_at,
      )
      .run();
  },
};

export function mapBuyer(raw: RawRecord, tenant: string): Buyer {
  return Buyer.parse({
    tenant_id: tenant,
    id: str(raw.id ?? raw.buyer_id ?? raw.email) || 'unknown',
    account_id: str(raw.account_id ?? raw.account),
    email: str(raw.email),
    role: str(raw.role, 'purchaser'),
    spending_limit_cents: num(raw.spending_limit_cents ?? raw.spending_limit),
    status: raw.status === 'disabled' ? 'disabled' : 'active',
    created_at: num(raw.created_at, 0),
  });
}

export async function listBuyersByAccount(
  env: Env,
  tenant: string,
  accountId: string,
): Promise<Buyer[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM buyers WHERE tenant_id = ? AND account_id = ? ORDER BY created_at DESC',
  )
    .bind(tenant, accountId)
    .all<BuyerRow>();
  return (rows.results ?? []).map(rowToBuyer);
}

export async function deleteBuyer(env: Env, tenant: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM buyers WHERE tenant_id = ? AND id = ?')
    .bind(tenant, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---- register entity types on the seam ----

registerEntityType<Account>({ type: 'account', native: accountStore, mapper: mapAccount });
registerEntityType<Buyer>({ type: 'buyer', native: buyerStore, mapper: mapBuyer });
