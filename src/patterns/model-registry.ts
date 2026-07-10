/**
 * Model provider registry — open registry of `ModelClient` factories.
 *
 * `buildModel` looks up the provider name resolved from `MODEL_ROUTES`
 * here. Built-in providers (Anthropic, OpenAI, Workers AI) register
 * themselves at module load in `model.ts`; deployments can add new
 * providers by calling `registerModelProvider(name, factory)` from
 * `src/composition.ts` (or any module imported before the first
 * `buildModel` call).
 */

import type { Env, ModelRoute } from '../env';
import type { Model } from '../manifests/schema';
import type { ModelClient } from './model';

export type ModelProviderFactory = (
  env: Env,
  modelId: string,
  route: ModelRoute,
  spec: Model,
) => ModelClient;

const providers = new Map<string, ModelProviderFactory>();

export function registerModelProvider(name: string, factory: ModelProviderFactory): void {
  providers.set(name, factory);
}

export function getModelProvider(name: string): ModelProviderFactory | undefined {
  return providers.get(name);
}

export function listModelProviders(): string[] {
  return [...providers.keys()];
}

/** Test-only — clears the registry. */
export function _resetModelProviderRegistry(): void {
  providers.clear();
}
