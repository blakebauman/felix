/**
 * compose(env) — wiring root. The only function that knows about both
 * Felix's tool catalog and the orchestrator's ToolProvider abstraction.
 *
 * Adding a tool: implement it as a Tool factory (using `defineTool`) under
 * `src/tools/builtins/`, then add one `provider.register(name, factory)`
 * line here. No orchestrator changes needed.
 */

import { z } from 'zod';
import { b2bToolFactories } from './commerce/b2b/tools';
import { commerceRecordConsentTool } from './commerce/consent/tool';
import { personalizationToolFactories } from './commerce/personalization/tools';
import { commerceCheckoutTool } from './commerce/stripe-tool';
import { commerceToolFactories } from './commerce/tools';
import { visualToolFactories } from './commerce/visual/tools';
import { getContext } from './context';
import type { Env } from './env';
import { resolveManifest } from './manifests/resolver';
import type { Manifest } from './manifests/schema';
import { evaluateExpression } from './security/expr';
import { getActivated, setActivated } from './skills/activation-store';
import { InMemoryToolProvider, type ToolProvider } from './tools/provider';
import { defineTool } from './tools/types';

async function loadForSkill(
  env: Env,
  tenantId: string,
  manifestId: string,
): Promise<Manifest | string> {
  if (!manifestId)
    return '[skill error] manifest_id required (set ctx.manifestId or pass explicitly)';
  try {
    const resolved = await resolveManifest(env, tenantId, manifestId);
    return resolved.manifest;
  } catch {
    return `[skill error] unknown manifest: ${manifestId}`;
  }
}

function declaredSkills(manifest: Manifest): string[] {
  return manifest.spec.skills.map((s) => s.name);
}

export function compose(_env: Env): ToolProvider {
  const provider = new InMemoryToolProvider();

  // Built-in tools register themselves here. For the bootstrap we wire a
  // couple of canonical examples — the calculator (smoke test) and a
  // minimal Tavily-shaped web_search stub.
  provider.register('calculator', () =>
    defineTool({
      name: 'calculator',
      description: 'Evaluate a basic arithmetic expression (supports + - * / and parentheses).',
      args: z.object({ expression: z.string() }).strict(),
      async handler({ expression }) {
        try {
          return String(evaluateExpression(expression));
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      },
    }),
  );

  // Skill activation tools. The overlay enforces a strict "restrict only"
  // semantic — a tenant may disable a skill the manifest declares, but it
  // cannot enable one the manifest didn't. The activation store keeps the
  // current set as a JSON array on (tenant_id, manifest_id).
  provider.register('list_skills', () =>
    defineTool({
      name: 'list_skills',
      description: 'List skills declared by this manifest and which are active for the caller.',
      args: z.object({ manifest_id: z.string().optional() }).strict(),
      async handler({ manifest_id }, invocationCtx) {
        const ctx = getContext();
        if (!ctx) return '[skill error] no request context';
        const tenantId = ctx.auth.principal.tenantId;
        // Prefer the pattern-supplied ToolInvocationCtx (set by react /
        // deep at dispatch time) over RequestContext, which no route
        // currently writes in production.
        const manifestId = manifest_id ?? invocationCtx?.manifestId ?? ctx.manifestId ?? '';
        const resolved = await loadForSkill(ctx.env, tenantId, manifestId);
        if (typeof resolved === 'string') return resolved;
        const declared = declaredSkills(resolved);
        const overlay = await getActivated(ctx.env, tenantId, manifestId);
        return JSON.stringify({
          declared,
          active: overlay,
          mode: overlay === null ? 'all-declared-active (no overlay)' : 'overlay',
        });
      },
    }),
  );

  provider.register('activate_skill', () =>
    defineTool({
      name: 'activate_skill',
      description:
        "Add a skill to the caller-tenant's active set for this manifest. Must be one declared in the manifest's spec.skills.",
      args: z.object({ skill: z.string(), manifest_id: z.string().optional() }).strict(),
      async handler({ skill, manifest_id }, invocationCtx) {
        const ctx = getContext();
        if (!ctx) return '[skill error] no request context';
        const tenantId = ctx.auth.principal.tenantId;
        // Prefer manifest_id explicitly passed by the model, then the
        // pattern-supplied ToolInvocationCtx (set by react/deep at
        // dispatch time), then RequestContext (unset in prod, but kept
        // as a last fallback for direct callers in tests).
        const manifestId = manifest_id ?? invocationCtx?.manifestId ?? ctx.manifestId ?? '';
        const resolved = await loadForSkill(ctx.env, tenantId, manifestId);
        if (typeof resolved === 'string') return resolved;
        const declared = declaredSkills(resolved);
        if (!declared.includes(skill)) {
          return `[skill error] '${skill}' is not declared in manifest '${manifestId}'`;
        }
        const current = (await getActivated(ctx.env, tenantId, manifestId)) ?? declared;
        if (current.includes(skill)) return `already active: ${skill}`;
        await setActivated(ctx.env, tenantId, manifestId, [...current, skill]);
        return `activated ${skill}`;
      },
    }),
  );

  provider.register('deactivate_skill', () =>
    defineTool({
      name: 'deactivate_skill',
      description: "Remove a skill from the caller-tenant's active set for this manifest.",
      args: z.object({ skill: z.string(), manifest_id: z.string().optional() }).strict(),
      async handler({ skill, manifest_id }, invocationCtx) {
        const ctx = getContext();
        if (!ctx) return '[skill error] no request context';
        const tenantId = ctx.auth.principal.tenantId;
        // Prefer manifest_id explicitly passed by the model, then the
        // pattern-supplied ToolInvocationCtx (set by react/deep at
        // dispatch time), then RequestContext (unset in prod, but kept
        // as a last fallback for direct callers in tests).
        const manifestId = manifest_id ?? invocationCtx?.manifestId ?? ctx.manifestId ?? '';
        const resolved = await loadForSkill(ctx.env, tenantId, manifestId);
        if (typeof resolved === 'string') return resolved;
        const declared = declaredSkills(resolved);
        const current = (await getActivated(ctx.env, tenantId, manifestId)) ?? declared;
        const next = current.filter((s) => s !== skill);
        await setActivated(ctx.env, tenantId, manifestId, next);
        return `deactivated ${skill}`;
      },
    }),
  );

  // Orderloop commerce tools. Catalog tools read the D1 `products` table; cart
  // tools read/write the session-backed cart; `commerce_checkout` creates a
  // Stripe Checkout Session (gate it with a manifest approval rule). The
  // external catalog-MCP path (spec.mcp_servers) remains an alternative source.
  for (const [name, factory] of Object.entries(commerceToolFactories())) {
    provider.register(name, factory);
  }
  provider.register('commerce_checkout', commerceCheckoutTool);
  provider.register('commerce_record_consent', commerceRecordConsentTool);

  // Predictive-personalization tools (recommendations). Read tenant from the
  // RequestContext + seed from session behavior like the commerce tools.
  for (const [name, factory] of Object.entries(personalizationToolFactories())) {
    provider.register(name, factory);
  }

  // Visual search — match an uploaded image against the catalog's image
  // embeddings (caption-then-embed in Vectorize).
  for (const [name, factory] of Object.entries(visualToolFactories())) {
    provider.register(name, factory);
  }

  // B2B procurement tools — quote-to-cash + authority for the procurement
  // multi-agent. Read tenant from the RequestContext like the commerce tools.
  for (const [name, factory] of Object.entries(b2bToolFactories())) {
    provider.register(name, factory);
  }

  return provider;
}
