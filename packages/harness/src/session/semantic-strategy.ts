/**
 * SemanticRetrievalStrategy — context-engineering primitive.
 *
 * On each render, embed the incoming user message via `env.AI` BGE,
 * embed each past `(message | tool_result)` event, and keep only the
 * top-K most relevant past events plus everything that's pinned.
 *
 * The motivation: on long-running threads, most history is irrelevant
 * to the current turn. Token spend on those events is cost-without-
 * value. A semantic top-K cut keeps the *important* turns and drops
 * the chaff, getting better quality at lower cost than a blind
 * windowed:N strategy.
 *
 * v1 trade-offs:
 *   - Embeddings are computed inline per render. No cross-render
 *     cache. For a session with 50 events on a 100-token turn this
 *     is ~50 BGE calls per render. Workers AI BGE is cheap (~$0.01
 *     per million tokens), so this is fine up to a few hundred events.
 *     A follow-up will add a cache (audit events with
 *     metadata.type='event_embedding') so repeat renders are O(new
 *     events only).
 *   - Falls back to `windowed:K` when `env.AI` is absent so dev
 *     loops without an AI binding don't crash.
 *   - Anchor messages (`metadata.pinned: true`) are kept regardless
 *     of similarity — they are by definition always relevant.
 */

import { getContext } from '../context';
import { recordCounter } from '../observability/metrics';
import type { ChatMessage } from '../patterns/types';
import { isPinned } from './strategies';
import { eventToChatMessage, type Session, type SessionEvent, type SessionStrategy } from './types';

const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

/**
 * Cosine similarity over two equal-length vectors. Inlined to avoid
 * a numpy-style dependency — this is hot path code.
 */
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * Concatenate an event's content into a single embedding-input string.
 * For tool_results, the content is the model-facing string; for
 * messages, we prepend the role so a user "what's the weather" and an
 * assistant "what's the weather" don't share an embedding.
 */
function embedText(event: SessionEvent): string {
  const role = event.role ?? '';
  const content = event.content ?? '';
  return `${role}: ${content}`.slice(0, 4000);
}

interface AiBinding {
  run(model: string, input: { text: string[] }): Promise<unknown>;
}

async function embed(ai: AiBinding, model: string, text: string): Promise<number[]> {
  const result = (await ai.run(model, { text: [text] })) as { data?: number[][] };
  return result.data?.[0] ?? [];
}

class SemanticRetrievalStrategy implements SessionStrategy {
  constructor(
    private readonly topK: number,
    private readonly model: string = DEFAULT_EMBEDDING_MODEL,
  ) {}

  async render(
    session: Session,
    incoming: ChatMessage[],
    opts: { systemPrompt: string },
  ): Promise<ChatMessage[]> {
    const events = await session.getEvents({ kinds: ['message', 'tool_result'] });
    const filtered = events.filter((e) => e.role !== 'system');
    if (filtered.length <= this.topK) {
      // Under K events — no need to embed, render everything.
      return [
        { role: 'system', content: opts.systemPrompt },
        ...filtered.map(eventToChatMessage),
        ...incoming,
      ];
    }

    // Pull the AI binding from the request-scoped Env. If absent,
    // degrade to windowed behavior using the same K as topK.
    const ai = getContext()?.env.AI as AiBinding | undefined;
    if (!ai) {
      const pinned = filtered.filter(isPinned);
      const unpinned = filtered.filter((e) => !isPinned(e));
      const windowed = unpinned.slice(-this.topK);
      const merged = [...pinned, ...windowed].sort((a, b) => a.seq - b.seq);
      return [
        { role: 'system', content: opts.systemPrompt },
        ...merged.map(eventToChatMessage),
        ...incoming,
      ];
    }

    // Use the LAST incoming message as the query (the model's current
    // turn). If there's no incoming, nothing to retrieve against — fall
    // through to a tail window.
    const query = incoming[incoming.length - 1]?.content ?? '';
    if (!query) {
      const tail = filtered.slice(-this.topK);
      return [
        { role: 'system', content: opts.systemPrompt },
        ...tail.map(eventToChatMessage),
        ...incoming,
      ];
    }

    const pinned = filtered.filter(isPinned);
    const candidates = filtered.filter((e) => !isPinned(e));

    let queryVec: number[];
    let candVecs: Array<{ event: SessionEvent; vec: number[] }>;
    try {
      queryVec = await embed(ai, this.model, query);
      candVecs = await Promise.all(
        candidates.map(async (event) => ({
          event,
          vec: await embed(ai, this.model, embedText(event)),
        })),
      );
    } catch {
      // Embedding failure — degrade to windowed. Emit a counter so a broken
      // semantic-retrieval path (Workers AI down / quota) is observable
      // instead of silently behaving like `windowed:N`.
      recordCounter('orchestrator_semantic_retrieval_failed', {
        manifest_id: getContext()?.manifestId ?? '',
      });
      const windowed = candidates.slice(-this.topK);
      const merged = [...pinned, ...windowed].sort((a, b) => a.seq - b.seq);
      return [
        { role: 'system', content: opts.systemPrompt },
        ...merged.map(eventToChatMessage),
        ...incoming,
      ];
    }

    // Score and pick top-K.
    const scored = candVecs
      .map(({ event, vec }) => ({ event, score: cosineSim(queryVec, vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topK)
      .map((s) => s.event);

    const merged = [...pinned, ...scored].sort((a, b) => a.seq - b.seq);
    return [
      { role: 'system', content: opts.systemPrompt },
      ...merged.map(eventToChatMessage),
      ...incoming,
    ];
  }
}

export function makeSemanticRetrievalSessionStrategy(
  topK: number,
  model?: string,
): SessionStrategy {
  return new SemanticRetrievalStrategy(topK, model);
}
