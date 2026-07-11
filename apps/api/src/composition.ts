/**
 * compose(env) — wiring root. The only function that knows about both
 * Felix's tool catalog and the orchestrator's ToolProvider abstraction.
 *
 * Adding a tool: implement it as a Tool factory (using `defineTool`) under
 * `src/tools/builtins/`, then add one `provider.register(name, factory)`
 * line here. No orchestrator changes needed.
 */

import { commercePlugin } from '@felix/commerce';
import { getContext } from '@felix/harness/context';
import type { Env } from '@felix/harness/env';
import { resolveManifest } from '@felix/harness/manifests/resolver';
import type { Manifest } from '@felix/harness/manifests/schema';
import type { FelixPlugin } from '@felix/harness/plugins/types';
import { evaluateExpression } from '@felix/harness/security/expr';
import { getActivated, setActivated } from '@felix/harness/skills/activation-store';
import { InMemoryToolProvider, type ToolProvider } from '@felix/harness/tools/provider';
import { defineTool } from '@felix/harness/tools/types';
import { z } from 'zod';

/**
 * The installed feature plugins. This is the ONLY core-side line that names a
 * plugin — removing a feature is deleting its entry here. `index.ts` threads
 * the list into `createApp` (routes, middleware knobs) and `scheduled`
 * (cron tasks); `compose` registers each plugin's tools.
 */
export function installedPlugins(): FelixPlugin[] {
  return [commercePlugin];
}

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

  // Feature-plugin tools (commerce catalog/cart/checkout, personalization,
  // visual search, B2B, …) register through the plugin seam.
  for (const plugin of installedPlugins()) {
    plugin.registerTools?.((name, factory) => provider.register(name, factory));
  }

  return provider;
}
