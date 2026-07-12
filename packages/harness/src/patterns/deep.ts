/**
 * deep pattern — react loop with plan_create / plan_get / plan_update_step
 * and a heavier system prompt nudging the model to plan before tool use.
 *
 * `PLAN_TOOLS` are injected by the core builder (`buildAgent`) into
 * `resolvedTools` BEFORE the governance pipeline, gated on
 * `pattern === 'deep'`. They therefore arrive here already wrapped by
 * policies/limits/guardrails/judges/approvals, exactly like every other
 * tool — this adapter does NOT re-inject them (doing so post-pipeline let
 * them escape every governance wrapper).
 */

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

registerPattern('deep', (ctx) =>
  buildDeepAgent({
    env: ctx.env,
    modelSpec: ctx.modelSpec,
    // `PLAN_TOOLS` are already present (and governance-wrapped) in
    // `ctx.tools` — the builder injects them pre-pipeline for `deep`.
    tools: ctx.tools,
    systemPrompt: ctx.systemPrompt,
    manifestId: ctx.manifestId,
    manifestVersion: ctx.manifestVersion,
    recursionLimit: ctx.recursionLimit ?? null,
    sessionStore: ctx.sessionStore ?? null,
    sessionStrategy: ctx.sessionStrategy ?? null,
    limits: ctx.limits,
    toolsRetrieval: ctx.manifest.spec.tools_retrieval,
    artifacts: ctx.manifest.spec.artifacts,
    guardrails: ctx.manifest.spec.guardrails,
    procedural: ctx.manifest.spec.procedural_memory,
  }),
);
