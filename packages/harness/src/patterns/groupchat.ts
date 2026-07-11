/**
 * groupchat pattern — round-robin sub-agents bounded by `max_turns`.
 * Each agent sees the running transcript and contributes one message.
 * The moderator system prompt is prepended to every sub-agent turn.
 *
 * Persistence: when `input.threadId` is set and the manifest declares a
 * non-`none` checkpointer (resolved at build time), the parent groupchat
 * agent owns the transcript — it renders prior turns through the
 * `SessionStrategy`, appends each new speaker's reply incrementally, and
 * **does not** forward the threadId to sub-agents. Forwarding would
 * race-write the same `ConversationDO` from every speaker; instead the
 * parent is the single writer.
 */

import { requireContext } from '../context';
import type { Env } from '../env';
import { guardFinalResponse, guardFinalResponseText } from '../guardrails/final-response';
import type { Guardrails } from '../guardrails/models';
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
import { buildModel, type ModelClient } from './model';
import { registerPattern } from './registry';
import type { Agent, ChatMessage, InvokeInput, InvokeResult, StreamEvent } from './types';

export interface BuildGroupchatOptions {
  env: Env;
  modelSpec: Model;
  subAgents: Record<string, Agent>;
  moderatorPrompt: string;
  maxTurns: number;
  manifestId: string;
  manifestVersion: string;
  /** Resolved at build time from `manifest.spec.memory.checkpointer`. */
  sessionStore?: SessionStore | null;
  /** Resolved at build time from `manifest.spec.session.strategy`. */
  sessionStrategy?: SessionStrategy | null;
  /** Parent guardrails — every speaker turn lands in the returned `messages`
   *  array and the persisted session log, so each gets the content filters;
   *  the final turn gets the full final-response guard, before persisting. */
  guardrails?: Guardrails | null;
}

export function buildGroupchatAgent(opts: BuildGroupchatOptions): Agent {
  const order = Object.keys(opts.subAgents);
  const sessionStore: SessionStore = opts.sessionStore ?? noopSessionStore;
  const strategy: SessionStrategy = opts.sessionStrategy ?? fullReplaySessionStrategy;
  // Built so summarizing strategies have a model client available when the
  // parent groupchat agent renders its transcript. Best-effort: most
  // groupchat manifests don't make parent-level model calls (sub-agents
  // bring their own), so an unresolvable `modelSpec.id` here shouldn't
  // fail the whole pattern build. If the strategy actually needs the
  // model later, it degrades to windowed render and proceeds.
  let model: ModelClient | undefined;
  try {
    model = buildModel(opts.env, opts.modelSpec);
  } catch {
    model = undefined;
  }

  function persist(session: Session, messages: readonly ChatMessage[]): void {
    if (messages.length === 0) return;
    const events: AppendableEvent[] = messages
      .filter((m) => m.role !== 'system')
      .map(chatMessageToEvent);
    persistFireAndForget(session, events, { manifestId: opts.manifestId });
  }

  return {
    tools: [],
    pattern: 'groupchat',
    manifestId: opts.manifestId,
    manifestVersion: opts.manifestVersion,

    async invoke(input: InvokeInput): Promise<InvokeResult> {
      requireContext();
      const session = sessionStore.open(input.threadId ?? '');
      // Strategy renders [system, ...history, ...incoming]; for groupchat
      // we drop the system header (the moderator prompt is supplied to
      // each sub-agent individually) and keep the rest as the transcript.
      const rendered = await strategy.render(session, input.messages, {
        systemPrompt: opts.moderatorPrompt,
        model,
      });
      const transcript: ChatMessage[] = rendered.filter((m) => m.role !== 'system');
      // Persist the new caller-supplied turns (everything past history).
      persist(session, input.messages);

      let last: ChatMessage = transcript[transcript.length - 1]!;
      for (let turn = 0; turn < opts.maxTurns; turn += 1) {
        const speaker = order[turn % order.length]!;
        const agent = opts.subAgents[speaker]!;
        // Stateless child invocation — children must not write to the
        // parent's threadId, so the transcript stays consistent.
        const reply = await agent.invoke({
          messages: [
            { role: 'system', content: `${opts.moderatorPrompt}\nYou are speaker '${speaker}'.` },
            ...transcript,
          ],
        });
        last = { ...reply.final, name: speaker };
        if (turn === opts.maxTurns - 1) {
          // Full final-response guard on the answer — BEFORE persisting, so
          // the session log (and the next thread render) sees the redacted
          // copy, matching react's guard-then-persist ordering.
          last = await guardFinalResponse(last, opts.guardrails ?? undefined, opts.manifestId);
        } else if (typeof last.content === 'string' && last.content.length > 0) {
          // Intermediate speaker turns are NOT internal: they're returned to
          // the caller in `messages` and persisted to the session log, so
          // they get the content filters too (guard-then-persist).
          const filtered = await guardFinalResponseText(
            last.content,
            opts.guardrails ?? undefined,
            opts.manifestId,
          );
          if (filtered !== last.content) last = { ...last, content: filtered };
        }
        transcript.push(last);
        persist(session, [last]);
      }
      return { messages: transcript, final: last };
    },

    async *streamEvents(input: InvokeInput): AsyncGenerator<StreamEvent> {
      requireContext();
      const result = await this.invoke(input);
      yield { event: 'on_chain_end', data: { output: result } };
    },
  };
}

registerPattern(
  'groupchat',
  (ctx) =>
    buildGroupchatAgent({
      env: ctx.env,
      modelSpec: ctx.modelSpec,
      subAgents: ctx.subAgents,
      moderatorPrompt: ctx.systemPrompt,
      maxTurns: ctx.maxTurns ?? 4,
      manifestId: ctx.manifestId,
      manifestVersion: ctx.manifestVersion,
      sessionStore: ctx.sessionStore ?? null,
      sessionStrategy: ctx.sessionStrategy ?? null,
      guardrails: ctx.manifest.spec.guardrails,
    }),
  { kind: 'multi-agent' },
);
