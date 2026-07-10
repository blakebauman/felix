/**
 * Pattern registry — open registry of pattern builders.
 *
 * A pattern is a function from `PatternBuildContext` (everything the builder
 * has prepared for a given manifest) to an `Agent`. Built-in patterns
 * register themselves at module load; deployments can register additional
 * patterns by calling `registerPattern(name, builder)` from
 * `src/composition.ts` (or any module that gets imported before the first
 * manifest build).
 *
 * The registry is module-level singleton state. That's deliberate: pattern
 * choice is a deployment property, not a per-request one, so a single
 * `Map<string, PatternBuilder>` per isolate is the right shape.
 */

import type { Env } from '../env';
import type { Limits } from '../limits/models';
import type { Manifest, Model } from '../manifests/schema';
import type { SessionStore, SessionStrategy } from '../session/types';
import type { Tool } from '../tools/types';
import type { Agent } from './types';

export interface PatternBuildContext {
  env: Env;
  manifest: Manifest;
  modelSpec: Model;
  /**
   * Resolved + governance-wrapped tool list (policies, limits, guardrails,
   * approvals already applied). Empty for the multi-agent patterns that
   * delegate to sub-agents.
   */
  tools: Tool[];
  /**
   * Resolved sub-agents keyed by manifest name. Empty for single-agent
   * patterns.
   */
  subAgents: Record<string, Agent>;
  systemPrompt: string;
  manifestId: string;
  manifestVersion: string;
  recursionLimit?: number | null;
  maxTurns?: number;
  aggregatorPrompt?: string;
  classifierPrompt?: string;
  sessionStore?: SessionStore | null;
  sessionStrategy?: SessionStrategy | null;
  limits?: Limits;
}

export type PatternBuilder = (ctx: PatternBuildContext) => Agent | Promise<Agent>;

/**
 * `single-agent` patterns operate on `ctx.tools` and forbid `sub_agents`.
 * `multi-agent` patterns operate on `ctx.subAgents`, require a non-empty
 * `sub_agents`, and forbid `peers`. Cross-field validation in
 * `manifests/validate.ts` reads this metadata, so registering a new
 * pattern with the right `kind` automatically gets the right constraints.
 */
export type PatternKind = 'single-agent' | 'multi-agent';

export interface PatternDescriptor {
  build: PatternBuilder;
  kind: PatternKind;
}

const patterns = new Map<string, PatternDescriptor>();

export function registerPattern(
  name: string,
  build: PatternBuilder,
  opts: { kind?: PatternKind } = {},
): void {
  patterns.set(name, { build, kind: opts.kind ?? 'single-agent' });
}

export function getPattern(name: string): PatternBuilder | undefined {
  return patterns.get(name)?.build;
}

export function getPatternDescriptor(name: string): PatternDescriptor | undefined {
  return patterns.get(name);
}

export function listPatterns(): string[] {
  return [...patterns.keys()];
}

export function isMultiAgentPattern(name: string): boolean {
  return patterns.get(name)?.kind === 'multi-agent';
}

/** Test-only — clears the registry. */
export function _resetPatternRegistry(): void {
  patterns.clear();
}
