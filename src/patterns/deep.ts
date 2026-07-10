/**
 * deep pattern — react loop with plan_create / plan_get / plan_update_step
 * injected at build time and a heavier system prompt nudging the model to
 * plan before tool use.
 *
 * Plan-tool injection lives in the registered pattern adapter (not in the
 * core builder) so the builder stays unaware of pattern-specific tool
 * requirements; a new pattern with its own tool set just registers its
 * own adapter.
 */

import { PLAN_TOOLS } from '../plans/tools';
import { type BuildReactOptions, buildReactAgent } from './react';
import { registerPattern } from './registry';
import type { Agent } from './types';

const DEEP_PROMPT_SUFFIX =
  '\n\nYou are a deep agent. Before tool use, draft a short plan via plan_create. Update plan steps as you go using plan_update_step. Finalize with a synthesis when steps are complete.';

export function buildDeepAgent(opts: BuildReactOptions): Agent {
  const agent = buildReactAgent({
    ...opts,
    systemPrompt: opts.systemPrompt + DEEP_PROMPT_SUFFIX,
  });
  return { ...agent, pattern: 'deep' };
}

registerPattern('deep', (ctx) => {
  const seen = new Set(ctx.tools.map((t) => t.name));
  const tools = [...ctx.tools];
  for (const p of PLAN_TOOLS) {
    if (!seen.has(p.name)) {
      tools.push(p);
      seen.add(p.name);
    }
  }
  return buildDeepAgent({
    env: ctx.env,
    modelSpec: ctx.modelSpec,
    tools,
    systemPrompt: ctx.systemPrompt,
    manifestId: ctx.manifestId,
    manifestVersion: ctx.manifestVersion,
    recursionLimit: ctx.recursionLimit ?? null,
    sessionStore: ctx.sessionStore ?? null,
    sessionStrategy: ctx.sessionStrategy ?? null,
    limits: ctx.limits,
  });
});
