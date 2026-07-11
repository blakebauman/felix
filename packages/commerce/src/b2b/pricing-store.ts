/**
 * Contract-price store (D1). Per (account, product) volume tiers. Tolerant of
 * malformed rows — a bad `tiers_json` resolves to "no contract" so pricing
 * falls back to the account discount / catalog rather than failing a quote.
 */

import type { Env } from '@felix/harness/env';
import { ContractPrice, type PriceTier } from './pricing-models';

interface Row {
  tenant_id: string;
  account_id: string;
  product_id: string;
  currency: string;
  tiers_json: string;
  created_at: number;
  updated_at: number;
}

function rowToContract(row: Row): ContractPrice | null {
  try {
    const tiers = JSON.parse(row.tiers_json) as PriceTier[];
    if (!Array.isArray(tiers)) return null;
    return ContractPrice.parse({
      tenant_id: row.tenant_id,
      account_id: row.account_id,
      product_id: row.product_id,
      currency: row.currency,
      tiers,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  } catch {
    return null;
  }
}

export async function getContractPrice(
  env: Env,
  tenant: string,
  accountId: string,
  productId: string,
): Promise<ContractPrice | null> {
  const row = await env.DB.prepare(
    'SELECT * FROM contract_prices WHERE tenant_id = ? AND account_id = ? AND product_id = ? LIMIT 1',
  )
    .bind(tenant, accountId, productId)
    .first<Row>();
  return row ? rowToContract(row) : null;
}

export async function listContractPrices(
  env: Env,
  tenant: string,
  accountId: string,
): Promise<ContractPrice[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM contract_prices WHERE tenant_id = ? AND account_id = ? ORDER BY product_id',
  )
    .bind(tenant, accountId)
    .all<Row>();
  return (rows.results ?? []).map(rowToContract).filter((c): c is ContractPrice => c !== null);
}

export async function upsertContractPrice(env: Env, contract: ContractPrice): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO contract_prices (tenant_id, account_id, product_id, currency, tiers_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, account_id, product_id) DO UPDATE SET
       currency = excluded.currency, tiers_json = excluded.tiers_json, updated_at = excluded.updated_at`,
  )
    .bind(
      contract.tenant_id,
      contract.account_id,
      contract.product_id,
      contract.currency,
      JSON.stringify(contract.tiers),
      contract.created_at,
      contract.updated_at,
    )
    .run();
}

export async function deleteContractPrice(
  env: Env,
  tenant: string,
  accountId: string,
  productId: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    'DELETE FROM contract_prices WHERE tenant_id = ? AND account_id = ? AND product_id = ?',
  )
    .bind(tenant, accountId, productId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
