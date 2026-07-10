/**
 * Brand provisioning: derive a per-brand `orderloop` manifest from the bundled
 * base (so the brand inherits the canonical tool list + checkout approval) and
 * write it under the brand's data tenant via the manifests store. After this,
 * resolveManifest(brand_tenant, 'orderloop') returns the branded agent.
 */

import type { Env } from '@felix/orchestrator/env';
import { loadManifest } from '@felix/orchestrator/manifests/loader';
import { invalidateActive } from '@felix/orchestrator/manifests/resolver';
import type { Manifest } from '@felix/orchestrator/manifests/schema';
import { ManifestSchema } from '@felix/orchestrator/manifests/schema';
import { createVersion } from '@felix/orchestrator/manifests/store';
import type { Brand } from './models';

const BASE_MANIFEST = 'orderloop';

/** Overlay brand identity onto the base manifest's system prompt + metadata. */
export function buildBrandManifest(base: Manifest, brand: Brand): Manifest {
  const id = brand.identity;
  const brandLines = [
    `You are the shopping assistant for ${brand.name}.`,
    id.greeting ? `Open with: "${id.greeting}"` : '',
    id.support_email ? `For order/support questions, point customers to ${id.support_email}.` : '',
    id.prompt_extra,
  ]
    .filter(Boolean)
    .join('\n');

  const draft: Manifest = {
    ...base,
    metadata: {
      ...base.metadata,
      description: `Orderloop storefront agent for ${brand.name}.`,
      tags: [...new Set([...base.metadata.tags, 'd2c', brand.id])],
    },
    spec: {
      ...base.spec,
      system_prompt: {
        ...base.spec.system_prompt,
        inline: `${brandLines}\n\n${base.spec.system_prompt.inline}`.trim(),
      },
    },
  };
  // Re-parse so defaults/strictness are enforced exactly like an authored manifest.
  return ManifestSchema.parse(draft);
}

/**
 * Create + activate the brand's `orderloop` manifest under its data tenant.
 * Returns the version number written.
 */
export async function provisionBrandManifest(
  env: Env,
  brand: Brand,
  createdBy: string,
): Promise<number> {
  const base = loadManifest(BASE_MANIFEST);
  const manifest = buildBrandManifest(base, brand);
  const row = await createVersion(env, {
    tenantId: brand.brand_tenant,
    name: BASE_MANIFEST,
    manifest,
    createdBy,
    comment: `Provisioned for brand ${brand.id}`,
    activate: true,
  });
  invalidateActive(brand.brand_tenant, BASE_MANIFEST);
  return row.version;
}
