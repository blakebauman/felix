/**
 * Resolve the billing provider for a tenant. Side-effect imports the built-in
 * providers so they're registered before resolution.
 */

import type { Env } from '../../env';
import { getBillingSettings } from './config-store';
import { getBillingProvider } from './registry';
import type { BillingProvider } from './types';
import './internal';
import './stripe';

export async function resolveBillingProvider(env: Env, tenant: string): Promise<BillingProvider> {
  const settings = await getBillingSettings(env, tenant);
  try {
    return getBillingProvider(settings.provider, settings.config);
  } catch {
    // Unknown/misconfigured provider degrades to internal rather than failing.
    return getBillingProvider('internal');
  }
}
