/**
 * Sync paths for `synced` mode — populate native D1 from a 3p source.
 *
 *   pullSync   — pull pages from the configured connector and upsert into D1.
 *                Driven on-demand (`POST /entities/:type/sync`) or by cron.
 *   pushImport — a 3p system pushes raw records to us (webhook); we map +
 *                upsert them. Trusted via the consumer shared secret.
 */

import type { Env } from '../env';
import { getDataSourceConfig } from './config-store';
import { getEntityConnector } from './connectors';
import { getEntityType } from './registry';
import type { RawRecord } from './types';

const MAX_PAGES = 50;

export interface SyncResult {
  upserted: number;
  pages: number;
}

/** Pull from the configured connector into native D1. */
export async function pullSync(env: Env, tenant: string, type: string): Promise<SyncResult> {
  const spec = getEntityType(type);
  if (!spec) throw new Error(`Unknown entity type: ${type}`);
  const config = await getDataSourceConfig(env, tenant, type);
  if (!config.connector) throw new Error(`No connector configured for ${type} on ${tenant}`);
  const connector = getEntityConnector(config.connector);

  let cursor: string | undefined;
  let upserted = 0;
  let pages = 0;
  for (; pages < MAX_PAGES; pages += 1) {
    const page = await connector.fetchPage(
      type,
      { limit: 200, ...(cursor ? { cursor } : {}) },
      { env, tenant },
    );
    for (const raw of page.records) {
      await spec.native.upsert(env, tenant, spec.mapper(raw, tenant));
      upserted += 1;
    }
    if (!page.cursor || page.records.length === 0) break;
    cursor = page.cursor;
  }
  return { upserted, pages: pages + 1 };
}

/** Upsert pushed raw records (webhook). */
export async function pushImport(
  env: Env,
  tenant: string,
  type: string,
  records: RawRecord[],
): Promise<SyncResult> {
  const spec = getEntityType(type);
  if (!spec) throw new Error(`Unknown entity type: ${type}`);
  let upserted = 0;
  for (const raw of records) {
    await spec.native.upsert(env, tenant, spec.mapper(raw, tenant));
    upserted += 1;
  }
  return { upserted, pages: 0 };
}
