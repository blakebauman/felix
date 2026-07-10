/**
 * Entity-source resolution. The single entry point callers use to read an
 * entity without knowing where it lives:
 *
 *   const accounts = await resolveEntitySource<Account>(env, tenant, 'account');
 *   const acct = await accounts.get(id);
 *
 * Reads the tenant's `data_sources` config + the registered entity-type spec,
 * and returns a native (D1) or federated (connector) source. `federated`
 * without a connector config falls back to native (fail-safe).
 */

import type { Env } from '../env';
import { getDataSourceConfig } from './config-store';
import { getEntityType } from './registry';
import { federatedSource, nativeSource } from './source';
import type { EntitySource } from './types';

export async function resolveEntitySource<T>(
  env: Env,
  tenant: string,
  type: string,
): Promise<EntitySource<T>> {
  const spec = getEntityType<T>(type);
  if (!spec) throw new Error(`Unknown entity type: ${type}`);
  const config = await getDataSourceConfig(env, tenant, type);

  if (config.mode === 'federated' && config.connector) {
    return federatedSource(env, tenant, spec, config.connector);
  }
  // native + synced both read from D1; an invalid federated config degrades to
  // native rather than failing the read.
  return nativeSource(env, tenant, spec.native, config.mode === 'synced' ? 'synced' : 'native');
}
