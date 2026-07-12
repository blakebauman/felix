/**
 * SessionStrategy implementations.
 *
 * `FullReplaySessionStrategy` (default — behavior-preserving with the
 * legacy checkpointer) and `WindowedSessionStrategy` (keep the last
 * N events) are the simple cases. `SummarizingSessionStrategy` calls
 * the model to compress events older than the keep-window into one
 * synthetic summary message — Anthropic's Managed Agents framing of
 * *"the harness chooses what to render"*: context-management decisions
 * live in one swappable strategy instead of in pattern code.
 *
 * The summary is cached as a `kind: 'audit'` event with metadata
 * `{ type: 'session_summary', covers_to_seq: N }`. A subsequent render
 * picks up the cached summary and only re-summarizes events newer than
 * `covers_to_seq`, so steady-state rendering is one DO read + one model
 * call only when new events have crossed the keep boundary.
 */

import { recordCounter } from '../observability/metrics';
import type { ChatMessage } from '../patterns/types';
import { makeSemanticRetrievalSessionStrategy } from './semantic-strategy';
import {
  eventToChatMessage,
  type Session,
  type SessionEvent,
  type SessionRenderOpts,
  type SessionStrategy,
} from './types';

const SUMMARY_METADATA_TYPE = 'session_summary';
const SUMMARIZER_SYSTEM_PROMPT =
  "You are summarizing a conversation between a user and an AI assistant so its context window can stay compact. Produce a brief summary (3–5 sentences) that preserves the user's primary goal, any decisions or commitments reached, constraints or preferences expressed, and pending questions or unfinished work. Do not invent facts. Do not include filler.";

/**
 * Anchor messages. A `SessionEvent` with `metadata.pinned: true`
 * survives every strategy's compaction:
 *
 *   - WindowedStrategy: pinned events are always rendered, prepended
 *     before the last-N window. The total render length grows beyond
 *     N when pins exist — that's intentional (mission, goal, hard
 *     constraints belong everywhere).
 *   - SummarizingStrategy: pinned events are never summarized; they
 *     pass through to the rendered output verbatim every render.
 *
 * Tools mark events as pinned by setting `metadata.pinned = true` on
 * their `tool_result` event — usually wrapped behind a `pin_message`
 * helper a future change exposes as a built-in tool.
 */
export function isPinned(event: SessionEvent): boolean {
  return (event.metadata as { pinned?: boolean } | undefined)?.pinned === true;
}

class FullReplayStrategy implements SessionStrategy {
  async render(
    session: Session,
    incoming: ChatMessage[],
    opts: { systemPrompt: string },
  ): Promise<ChatMessage[]> {
    const events = await session.getEvents({ kinds: ['message', 'tool_result'] });
    const history = events
      // System prompts come from the manifest at build time, not from history.
      .filter((e) => e.role !== 'system')
      .map(eventToChatMessage);
    return [{ role: 'system', content: opts.systemPrompt }, ...history, ...incoming];
  }
}

/**
 * Render a session as a system message + the last `maxTurns` events +
 * incoming. Keeps token usage bounded on long conversations without
 * losing the active turn structure.
 */
class WindowedStrategy implements SessionStrategy {
  constructor(private readonly maxTurns: number) {}
  async render(
    session: Session,
    incoming: ChatMessage[],
    opts: { systemPrompt: string },
  ): Promise<ChatMessage[]> {
    const events = await session.getEvents({ kinds: ['message', 'tool_result'] });
    const filtered = events.filter((e) => e.role !== 'system');
    // Pinned events always render. Compute the window over the non-
    // pinned subset, then re-merge in seq order so the conversation
    // reads chronologically. Total length = (pinned count) + maxTurns.
    const pinned = filtered.filter(isPinned);
    const unpinned = filtered.filter((e) => !isPinned(e));
    const windowed = this.maxTurns > 0 ? unpinned.slice(-this.maxTurns) : [];
    const merged = [...pinned, ...windowed].sort((a, b) => a.seq - b.seq);
    return [
      { role: 'system', content: opts.systemPrompt },
      ...merged.map(eventToChatMessage),
      ...incoming,
    ];
  }
}

/**
 * Keep the newest `keep` raw events; when older events exist, call the
 * model to compress them into a synthetic summary that becomes a system
 * message in the rendered output. Summaries are cached as `kind: 'audit'`
 * events so subsequent renders skip the model call until new events
 * cross the keep boundary again.
 *
 * Failure mode: if no model is supplied (the strategy was configured but
 * the pattern didn't pass one), or the summarization call throws, the
 * strategy degrades to windowed behavior instead of failing the request.
 */
class SummarizingStrategy implements SessionStrategy {
  constructor(private readonly keep: number) {}

  async render(
    session: Session,
    incoming: ChatMessage[],
    opts: SessionRenderOpts,
  ): Promise<ChatMessage[]> {
    const all = await session.getEvents({ kinds: ['message', 'tool_result', 'audit'] });
    const summaryEvents = all
      .filter(
        (e) =>
          e.kind === 'audit' &&
          (e.metadata as { type?: string } | undefined)?.type === SUMMARY_METADATA_TYPE,
      )
      .sort((a, b) => b.seq - a.seq);
    const latestSummary = summaryEvents[0];
    const covered =
      (latestSummary?.metadata as { covers_to_seq?: number } | undefined)?.covers_to_seq ?? -1;

    const raw = all
      .filter((e) => e.kind !== 'audit' && e.role !== 'system')
      .filter((e) => e.seq > covered);

    // Pinned events bypass the summarizer entirely. They go straight
    // to the rendered output and never count against the keep window.
    const pinned = raw.filter(isPinned);
    const compactable = raw.filter((e) => !isPinned(e));

    if (compactable.length <= this.keep) {
      // Already under the keep window — render with the cached summary (if
      // any) plus everything in `compactable`, with pinned re-merged in seq order.
      const merged = [...pinned, ...compactable].sort((a, b) => a.seq - b.seq);
      return assemble(opts.systemPrompt, latestSummary?.content, merged, incoming);
    }

    const toSummarize = compactable.slice(0, compactable.length - this.keep);
    const keepEvents = compactable.slice(compactable.length - this.keep);

    if (!opts.model || toSummarize.length === 0) {
      // No model available — degrade to windowed behavior using the
      // cached summary (if any), the keep window, and pinned events.
      const merged = [...pinned, ...keepEvents].sort((a, b) => a.seq - b.seq);
      return assemble(opts.systemPrompt, latestSummary?.content, merged, incoming);
    }

    let newSummary: string;
    try {
      const summarizerMessages: ChatMessage[] = [
        { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
        ...(latestSummary?.content
          ? [
              {
                role: 'system' as const,
                content: `Summary of the conversation so far:\n${latestSummary.content}`,
              },
            ]
          : []),
        ...toSummarize.map(eventToChatMessage),
        {
          role: 'user',
          content:
            'Summarize the conversation above following the system prompt. Output only the summary.',
        },
      ];
      const result = await opts.model.chat(summarizerMessages, []);
      newSummary = result.message.content.trim();
      if (!newSummary) throw new Error('summarizer returned empty content');
    } catch {
      // Degrade gracefully — the model call failed, so render windowed
      // with pinned events kept verbatim. Emit a counter so the fleet-wide
      // degrade (summarizing -> windowed) is visible instead of silent.
      recordCounter('orchestrator_session_summarize_failures');
      const merged = [...pinned, ...keepEvents].sort((a, b) => a.seq - b.seq);
      return assemble(opts.systemPrompt, latestSummary?.content, merged, incoming);
    }

    // Cache the new summary. Awaited (not fire-and-forget) so the next
    // render sees it on the read path — race-free against the same
    // pattern invocation's next turn.
    const lastSummarizedSeq = toSummarize[toSummarize.length - 1]!.seq;
    try {
      await session.append({
        kind: 'audit',
        content: newSummary,
        metadata: { type: SUMMARY_METADATA_TYPE, covers_to_seq: lastSummarizedSeq },
      });
    } catch {
      // Persistence failure is non-fatal for the current render — the
      // summary still goes into the working-set; future renders just
      // won't have the cache.
    }

    const merged = [...pinned, ...keepEvents].sort((a, b) => a.seq - b.seq);
    return assemble(opts.systemPrompt, newSummary, merged, incoming);
  }
}

function assemble(
  systemPrompt: string,
  summary: string | undefined,
  keep: SessionEvent[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
  if (summary) {
    out.push({ role: 'system', content: `Summary of the conversation so far:\n${summary}` });
  }
  out.push(...keep.map(eventToChatMessage));
  out.push(...incoming);
  return out;
}

export const fullReplaySessionStrategy: SessionStrategy = new FullReplayStrategy();

export function makeWindowedSessionStrategy(maxTurns: number): SessionStrategy {
  return new WindowedStrategy(maxTurns);
}

export function makeSummarizingSessionStrategy(keep: number): SessionStrategy {
  return new SummarizingStrategy(keep);
}

/**
 * Resolve a strategy from the manifest field. `full_replay` (default) is
 * behavior-preserving with the legacy checkpointer. `windowed:<N>` keeps
 * the last N events. `summarizing:<N>` keeps the last N events and
 * model-summarizes everything older. `semantic:<N>` keeps the
 * top-N most relevant past events by cosine similarity to the incoming
 * user message — falls back to windowed when no AI binding is wired.
 * Invalid specs fall back to full replay.
 */
export function getSessionStrategy(spec?: string | null): SessionStrategy {
  if (!spec || spec === 'full_replay') return fullReplaySessionStrategy;
  const windowed = spec.match(/^windowed:(\d+)$/);
  if (windowed) {
    const n = Number.parseInt(windowed[1]!, 10);
    if (Number.isFinite(n) && n > 0) return makeWindowedSessionStrategy(n);
  }
  const summarizing = spec.match(/^summarizing:(\d+)$/);
  if (summarizing) {
    const n = Number.parseInt(summarizing[1]!, 10);
    if (Number.isFinite(n) && n > 0) return makeSummarizingSessionStrategy(n);
  }
  const semantic = spec.match(/^semantic:(\d+)$/);
  if (semantic) {
    const n = Number.parseInt(semantic[1]!, 10);
    if (Number.isFinite(n) && n > 0) return makeSemanticRetrievalSessionStrategy(n);
  }
  return fullReplaySessionStrategy;
}
