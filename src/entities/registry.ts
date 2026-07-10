/**
 * Entity-type registry. The owning module (B2B, catalog, brands, …) registers
 * each entity type's native store + external mapper here at module load, the
 * same open-registry pattern used for patterns / model providers / connectors.
 * The resolver and sync paths look specs up by type.
 */

import type { EntityTypeSpec } from './types';

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous specs keyed by type
const registry = new Map<string, EntityTypeSpec<any>>();

export function registerEntityType<T>(spec: EntityTypeSpec<T>): void {
  registry.set(spec.type, spec);
}

export function getEntityType<T = unknown>(type: string): EntityTypeSpec<T> | undefined {
  return registry.get(type) as EntityTypeSpec<T> | undefined;
}

export function listEntityTypes(): string[] {
  return [...registry.keys()];
}
