/**
 * `data_sources` config store (D1). Per tenant per entity type, records the
 * mode + connector config. Absent row → native (the default).
 */

import type { Env } from '@felix/harness/env';
import type { ConnectorConfig, DataSourceConfig, EntityMode } from './types';

interface Row {
  mode: string;
  connector_json: string;
}

export async function getDataSourceConfig(
  env: Env,
  tenant: string,
  type: string,
): Promise<DataSourceConfig> {
  const row = await env.DB.prepare(
    'SELECT mode, connector_json FROM data_sources WHERE tenant_id = ? AND entity_type = ? LIMIT 1',
  )
    .bind(tenant, type)
    .first<Row>();
  if (!row) return { mode: 'native' };
  const mode = (['native', 'federated', 'synced'] as const).includes(row.mode as EntityMode)
    ? (row.mode as EntityMode)
    : 'native';
  let connector: ConnectorConfig | undefined;
  try {
    const parsed = JSON.parse(row.connector_json) as ConnectorConfig;
    if (parsed?.kind && parsed.url) connector = parsed;
  } catch {
    /* ignore */
  }
  return { mode, ...(connector ? { connector } : {}) };
}

export async function setDataSourceConfig(
  env: Env,
  tenant: string,
  type: string,
  config: DataSourceConfig,
  updatedBy: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO data_sources (tenant_id, entity_type, mode, connector_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, entity_type) DO UPDATE SET
       mode = excluded.mode,
       connector_json = excluded.connector_json,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  )
    .bind(tenant, type, config.mode, JSON.stringify(config.connector ?? {}), Date.now(), updatedBy)
    .run();
}
