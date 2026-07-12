/**
 * Contract-price store (Postgres). Per (account, product) volume tiers.
 * Tolerant of malformed rows — a bad `tiers_json` resolves to "no contract" so
 * pricing falls back to the account discount / catalog rather than failing a
 * quote.
 */

import { getDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';
import { ContractPrice, type PriceTier } from './pricing-models';

interface Row {
  tenant_id: string;
  account_id: string;
  product_id: string;
  currency: string;
  tiers_json: PriceTier[] | null;
  created_at: number;
  updated_at: number;
}

function rowToContract(row: Row): ContractPrice | null {
  try {
    const tiers = row.tiers_json;
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
  const sql = getDb(env);
  const rows = await sql<Row[]>`
    SELECT * FROM contract_prices
      WHERE tenant_id = ${tenant} AND account_id = ${accountId} AND product_id = ${productId}
      LIMIT 1
  `;
  return rows[0] ? rowToContract(rows[0]) : null;
}

export async function listContractPrices(
  env: Env,
  tenant: string,
  accountId: string,
): Promise<ContractPrice[]> {
  const sql = getDb(env);
  const rows = await sql<Row[]>`
    SELECT * FROM contract_prices
      WHERE tenant_id = ${tenant} AND account_id = ${accountId}
      ORDER BY product_id
  `;
  return rows.map(rowToContract).filter((c): c is ContractPrice => c !== null);
}

export async function upsertContractPrice(env: Env, contract: ContractPrice): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO contract_prices (tenant_id, account_id, product_id, currency, tiers_json,
                                 created_at, updated_at)
      VALUES (${contract.tenant_id}, ${contract.account_id}, ${contract.product_id},
              ${contract.currency}, ${contract.tiers as unknown as readonly unknown[]},
              ${contract.created_at}, ${contract.updated_at})
      ON CONFLICT (tenant_id, account_id, product_id) DO UPDATE SET
        currency = excluded.currency, tiers_json = excluded.tiers_json,
        updated_at = excluded.updated_at
  `;
}

export async function deleteContractPrice(
  env: Env,
  tenant: string,
  accountId: string,
  productId: string,
): Promise<boolean> {
  const sql = getDb(env);
  const res = await sql`
    DELETE FROM contract_prices
      WHERE tenant_id = ${tenant} AND account_id = ${accountId} AND product_id = ${productId}
  `;
  return res.count > 0;
}
