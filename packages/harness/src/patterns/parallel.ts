/**
 * parallel pattern — fan out the user turn to every sub-agent
 * concurrently, then synthesize a final answer with the aggregator
 * prompt.
 *
 * Persistence: when `input.threadId` is set and the manifest declares a
 * non-`none` checkpointer (resolved at build time), the parent aggregator
 * owns the transcript — it renders prior turns through the `SessionStrategy`,
 * fans the hydrated working-set out to the (stateless) children, and appends
 * the new caller turn + synthesized final answer to the parent thread. It
 * deliberately **does not** forward the threadId to children: every child
 * would race-write the same `ConversationDO`. This makes multi-turn
 * `parallel` manifests actually stateful instead of silently forgetting.
 */

import { requireContext } from '../context';
import type { Env } from '../env';
import { guardFinalResponse } from '../guardrails/final-response';
import type { Guardrails } from '../guardrails/models';
import { DEFAULT_LIMITS, type Limits } from '../limits/models';
import { currentSignal } from '../limits/state';
import { checkPreflightTokenBudget, checkTokenBudget } from '../limits/wrap';
import type { Model } from '../manifests/schema';
import { noopSessionStore, persistFireAndForget } from '../session/do-session';
import { fullReplaySessionStrategy } from '../session/strategies';
import {
  type AppendableEvent,
  chatMessageToEvent,
  type Session,
  type SessionStore,
  type SessionStrategy,
} from '../session/types';
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
  /** Resolved at build time from `manifest.spec.memory.checkpointer`. */
  sessionStore?: SessionStore | null;
  /** Resolved at build time from `manifest.spec.session.strategy`. */
  sessionStrategy?: SessionStrategy | null;
}

export function buildParallelAgent(opts: BuildParallelOptions): Agent {
  const model = buildModel(opts.env, opts.modelSpec);
  const limits: Limits = opts.limits ?? DEFAULT_LIMITS;
  const sessionStore: SessionStore = opts.sessionStore ?? noopSessionStore;
  const strategy: SessionStrategy = opts.sessionStrategy ?? fullReplaySessionStrategy;

  function persistParent(session: Session, messages: readonly ChatMessage[]): void {
    if (messages.length === 0) return;
    const events: AppendableEvent[] = messages
      .filter((m) => m.role !== 'system')
      .map(chatMessageToEvent);
    persistFireAndForget(session, events, { manifestId: opts.manifestId });
  }

  async function fanout(
    messages: ChatMessage[],
  ): Promise<Array<{ name: string; final: ChatMessage }>> {
    // Children are stateless workers for this run — no threadId, so sharing
    // one would race-write the same ConversationDO. The parent aggregator is
    // the persistent entity; children see the hydrated transcript but write
    // nothing back.
    const childInput: InvokeInput = { messages };
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
      // Open the parent session and hydrate prior turns; `render` reads
      // before we persist the new caller turn (matching react's ordering).
      const session = sessionStore.open(input.threadId ?? '');
      const rendered = await strategy.render(session, input.messages, {
        systemPrompt: opts.aggregatorPrompt,
        model,
      });
      // Persist the new caller-supplied turns to the parent thread.
      persistParent(session, input.messages);
      // Fan the hydrated conversation (system header dropped) out to the
      // stateless children so a continuation carries context.
      const childMessages = rendered.filter((m) => m.role !== 'system');
      const parts = await fanout(childMessages);
      const final = await aggregate(parts);
      // Persist the synthesized answer so the next turn on this thread sees it.
      persistParent(session, [final]);
      return { messages: [...childMessages, final], final };
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
      sessionStore: ctx.sessionStore ?? null,
      sessionStrategy: ctx.sessionStrategy ?? null,
    }),
  { kind: 'multi-agent' },
);
