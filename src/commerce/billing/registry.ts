/**
 * Open registry for billing providers — the same pattern as patterns / model
 * providers / entity connectors. New PSPs call `registerBillingProvider(kind,
 * factory)` at module load.
 */

import type { BillingProvider, BillingProviderFactory } from './types';

const factories = new Map<string, BillingProviderFactory>();

export function registerBillingProvider(kind: string, factory: BillingProviderFactory): void {
  factories.set(kind, factory);
}

export function getBillingProvider(
  kind: string,
  config: Record<string, unknown> = {},
): BillingProvider {
  const factory = factories.get(kind);
  if (!factory) {
    throw new Error(
      `Unknown billing provider: ${kind} (registered: ${[...factories.keys()].join(', ')})`,
    );
  }
  return factory(config);
}

export function listBillingProviders(): string[] {
  return [...factories.keys()];
}
