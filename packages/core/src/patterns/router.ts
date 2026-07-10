/**
 * router pattern — classifier model picks exactly one sub-agent and
 * forwards the user turn.
 *
 * The classifier sees the user message and a system prompt that
 * enumerates allowed routes; it must reply with one of the registered
 * sub-agent names. Anything else falls back to the first sub-agent.
 */

import { requireContext } from '../context';
import type { Env } from '../env';
import { DEFAULT_LIMITS, type Limits } from '../limits/models';
import { currentSignal } from '../limits/state';
import { checkPreflightTokenBudget, checkTokenBudget } from '../limits/wrap';
import type { Model } from '../manifests/schema';
import { buildModel, recordUsage } from './model';
import { registerPattern } from './registry';
import type { Agent, ChatMessage, InvokeInput, InvokeResult, StreamEvent } from './types';

export interface BuildRouterOptions {
  env: Env;
  modelSpec: Model;
  subAgents: Record<string, Agent>;
  classifierPrompt: string;
  manifestId: string;
  manifestVersion: string;
  /** Manifest limits — checked before the classifier model call so a
   *  blown token budget short-circuits to the fallback route. */
  limits?: Limits;
}

export function buildRouterAgent(opts: BuildRouterOptions): Agent {
  const model = buildModel(opts.env, opts.modelSpec);
  const subNames = Object.keys(opts.subAgents);
  const fallback = subNames[0]!;
  const limits: Limits = opts.limits ?? DEFAULT_LIMITS;

  async function classify(messages: ChatMessage[]): Promise<string> {
    const userTurn = [...messages].reverse().find((m) => m.role === 'user');
    if (!userTurn) return fallback;
    // If the request has already blown its token budget (e.g. on a retry
    // or after sub-agent fan-in via shared LimitState), don't spend more
    // tokens classifying — fall back deterministically.
    const classifyMessages: ChatMessage[] = [
      {
        role: 'system',
        content: `${opts.classifierPrompt}\nRespond with one of: ${subNames.join(', ')}.`,
      },
      { role: 'user', content: userTurn.content },
    ];
    const preDeny =
      (await checkPreflightTokenBudget(model, classifyMessages, [], limits, opts.manifestId)) ??
      checkTokenBudget(limits, opts.manifestId);
    if (preDeny) return fallback;
    const result = await model.chat(classifyMessages, [], {
      temperature: 0,
      maxTokens: 16,
      signal: currentSignal(),
    });
    recordUsage(result, { manifestId: opts.manifestId, modelId: opts.modelSpec.id });
    const choice = (result.message.content ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    return subNames.find((n) => n.toLowerCase() === choice) ?? fallback;
  }

  return {
    tools: [],
    pattern: 'router',
    manifestId: opts.manifestId,
    manifestVersion: opts.manifestVersion,

    async invoke(input: InvokeInput): Promise<InvokeResult> {
      requireContext();
      const route = await classify(input.messages);
      const child = opts.subAgents[route] ?? opts.subAgents[fallback]!;
      return child.invoke(input);
    },

    async *streamEvents(input: InvokeInput): AsyncGenerator<StreamEvent> {
      requireContext();
      const route = await classify(input.messages);
      const child = opts.subAgents[route] ?? opts.subAgents[fallback]!;
      yield* child.streamEvents(input);
    },
  };
}

registerPattern(
  'router',
  (ctx) =>
    buildRouterAgent({
      env: ctx.env,
      modelSpec: ctx.modelSpec,
      subAgents: ctx.subAgents,
      classifierPrompt: ctx.systemPrompt,
      manifestId: ctx.manifestId,
      manifestVersion: ctx.manifestVersion,
      limits: ctx.limits,
    }),
  { kind: 'multi-agent' },
);
