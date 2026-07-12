/**
 * `data_sources` config store (Postgres). Per tenant per entity type, records
 * the mode + connector config. Absent row → native (the default).
 */

import { getDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';
import type { ConnectorConfig, DataSourceConfig, EntityMode } from './types';

interface Row {
  mode: string;
  connector_json: ConnectorConfig | null;
}

export async function getDataSourceConfig(
  env: Env,
  tenant: string,
  type: string,
): Promise<DataSourceConfig> {
  const sql = getDb(env);
  const rows = await sql<Row[]>`
    SELECT mode, connector_json FROM data_sources
      WHERE tenant_id = ${tenant} AND entity_type = ${type} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { mode: 'native' };
  const mode = (['native', 'federated', 'synced'] as const).includes(row.mode as EntityMode)
    ? (row.mode as EntityMode)
    : 'native';
  let connector: ConnectorConfig | undefined;
  const parsed = row.connector_json;
  if (parsed?.kind && parsed.url) connector = parsed;
  return { mode, ...(connector ? { connector } : {}) };
}

export async function setDataSourceConfig(
  env: Env,
  tenant: string,
  type: string,
  config: DataSourceConfig,
  updatedBy: string,
): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO data_sources (tenant_id, entity_type, mode, connector_json, updated_at, updated_by)
      VALUES (${tenant}, ${type}, ${config.mode},
              ${(config.connector ?? {}) as unknown as Record<string, unknown>},
              ${Date.now()}, ${updatedBy})
      ON CONFLICT (tenant_id, entity_type) DO UPDATE SET
        mode = excluded.mode,
        connector_json = excluded.connector_json,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
  `;
}
