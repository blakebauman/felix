/**
 * parallel pattern — fan out the user turn to every sub-agent
 * concurrently, then synthesize a final answer with the aggregator
 * prompt.
 */

import { requireContext } from '../context';
import type { Env } from '../env';
import { guardFinalResponse } from '../guardrails/final-response';
import type { Guardrails } from '../guardrails/models';
import { DEFAULT_LIMITS, type Limits } from '../limits/models';
import { currentSignal } from '../limits/state';
import { checkPreflightTokenBudget, checkTokenBudget } from '../limits/wrap';
import type { Model } from '../manifests/schema';
import { buildModel, recordUsage } from './model';
import { registerPattern } from './registry';
import type { Agent, ChatMessage, InvokeInput, InvokeResult, StreamEvent } from './types';

export interface BuildParallelOptions {
  env: Env;
  modelSpec: Model;
  subAgents: Record<string, Agent>;
  aggregatorPrompt: string;
  manifestId: string;
  manifestVersion: string;
  /** Manifest limits — checked before the aggregator model call so a
   *  blown token budget short-circuits to a deny message instead of
   *  spending more tokens synthesizing. */
  limits?: Limits;
  /** Parent guardrails — the final-response guard runs over the aggregator's
   *  synthesized answer (children run their own guardrails independently). */
  guardrails?: Guardrails | null;
}

export function buildParallelAgent(opts: BuildParallelOptions): Agent {
  const model = buildModel(opts.env, opts.modelSpec);
  const limits: Limits = opts.limits ?? DEFAULT_LIMITS;

  async function fanout(input: InvokeInput): Promise<Array<{ name: string; final: ChatMessage }>> {
    // Strip threadId before fanning out — children are stateless workers
    // for this run, and sharing a threadId would race-write the same
    // ConversationDO. The parent aggregator is the persistent entity.
    const childInput: InvokeInput = { messages: input.messages };
    const entries = Object.entries(opts.subAgents);
    const results = await Promise.all(
      entries.map(async ([name, agent]) => ({
        name,
        final: (await agent.invoke(childInput)).final,
      })),
    );
    return results;
  }

  async function aggregate(
    parts: Array<{ name: string; final: ChatMessage }>,
  ): Promise<ChatMessage> {
    // Sub-agents already accumulated tokens into the shared LimitState;
    // the parent's aggregator call is gated by *its* manifest's caps.
    const summary = parts.map((p) => `### ${p.name}\n${p.final.content}`).join('\n\n');
    const aggregatorMessages: ChatMessage[] = [
      { role: 'system', content: opts.aggregatorPrompt },
      {
        role: 'user',
        content: `Synthesize a single coherent answer from these sub-agent outputs:\n\n${summary}`,
      },
    ];
    const budgetDeny =
      (await checkPreflightTokenBudget(model, aggregatorMessages, [], limits, opts.manifestId)) ??
      checkTokenBudget(limits, opts.manifestId);
    if (budgetDeny) {
      return { role: 'assistant', content: budgetDeny };
    }
    const result = await model.chat(aggregatorMessages, [], { signal: currentSignal() });
    recordUsage(result, { manifestId: opts.manifestId, modelId: opts.modelSpec.id });
    // Guard the synthesized user-facing answer (no-op unless `final_response`
    // is a target). The aggregator is a parent-level model call, so children's
    // own guardrails don't cover it.
    return guardFinalResponse(result.message, opts.guardrails ?? undefined, opts.manifestId);
  }

  return {
    tools: [],
    pattern: 'parallel',
    manifestId: opts.manifestId,
    manifestVersion: opts.manifestVersion,

    async invoke(input: InvokeInput): Promise<InvokeResult> {
      requireContext();
      const parts = await fanout(input);
      const final = await aggregate(parts);
      return { messages: [...input.messages, final], final };
    },

    async *streamEvents(input: InvokeInput): AsyncGenerator<StreamEvent> {
      requireContext();
      const result = await this.invoke(input);
      yield { event: 'on_chain_end', data: { output: result } };
    },
  };
}

registerPattern(
  'parallel',
  (ctx) =>
    buildParallelAgent({
      env: ctx.env,
      modelSpec: ctx.modelSpec,
      subAgents: ctx.subAgents,
      aggregatorPrompt: ctx.aggregatorPrompt || ctx.systemPrompt,
      manifestId: ctx.manifestId,
      manifestVersion: ctx.manifestVersion,
      limits: ctx.limits,
      guardrails: ctx.manifest.spec.guardrails,
    }),
  { kind: 'multi-agent' },
);
