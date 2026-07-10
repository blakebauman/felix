/**
 * Just-in-time tool retrieval — context-engineering primitive.
 *
 * Every tool's full schema is normally injected on every model call.
 * That's fine for 10 tools and disastrous at 100: each schema costs
 * ~50-300 tokens and crowds the model's attention. At scale this is
 * the dominant per-turn cost.
 *
 * `selectTopKTools` ranks the available tools by cosine similarity
 * between the tool's `description` and the last few turns of
 * conversation context, then returns the top-K. The model only sees
 * the schemas of tools likely to be relevant.
 *
 * Trade-offs:
 *   - Selection requires `env.AI` for the BGE embedding model. When
 *     absent (dev probes without an AI binding), the helper passes
 *     through to the unfiltered tool list — no silent breakage.
 *   - Tool embeddings are cached per-isolate by tool name + a hash of
 *     the description. The cache survives tool-list reordering and
 *     manifest hot-reloads as long as descriptions don't change.
 *   - The query is the last 3 message contents concatenated — enough
 *     to capture intent across follow-up questions without including
 *     stale turns. Tune `QUERY_TURN_WINDOW` if longer-horizon turns
 *     benefit from more context.
 */

import { getContext } from '../context';
import type { ChatMessage } from '../patterns/types';
import type { Tool } from './types';

const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const QUERY_TURN_WINDOW = 3;
const QUERY_MAX_CHARS = 2000;
const TOOL_DESC_MAX_CHARS = 1000;

interface AiBinding {
  run(model: string, input: { text: string[] }): Promise<unknown>;
}

/** Per-isolate cache of `(toolName + descHash) → embedding vector`. */
const toolEmbeddingCache = new Map<string, number[]>();

function fnv1a(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function cacheKey(name: string, description: string): string {
  return `${name}#${fnv1a(description)}`;
}

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

async function embedOne(ai: AiBinding, model: string, text: string): Promise<number[]> {
  const result = (await ai.run(model, { text: [text] })) as { data?: number[][] };
  return result.data?.[0] ?? [];
}

async function embedTools(
  ai: AiBinding,
  model: string,
  tools: readonly Tool[],
): Promise<Map<Tool, number[]>> {
  const out = new Map<Tool, number[]>();
  // Hits the cache where possible; only embeds new (tool, description)
  // pairs. The remote BGE call is the bottleneck — serial here so we
  // don't hit Workers AI rate caps on a large catalog. Parallelizing
  // is safe but bursts of >50 concurrent calls trip throttling.
  for (const tool of tools) {
    const key = cacheKey(tool.name, tool.description);
    const cached = toolEmbeddingCache.get(key);
    if (cached) {
      out.set(tool, cached);
      continue;
    }
    const text = `${tool.name}: ${tool.description}`.slice(0, TOOL_DESC_MAX_CHARS);
    try {
      const vec = await embedOne(ai, model, text);
      toolEmbeddingCache.set(key, vec);
      out.set(tool, vec);
    } catch {
      // One tool failing to embed shouldn't kill the whole retrieval —
      // skip it (it'll be missing from the filtered set; that's
      // strictly more conservative than including it ranked low).
    }
  }
  return out;
}

export interface ToolsRetrievalOpts {
  enabled: boolean;
  top_k: number;
  model?: string;
}

/**
 * Filter `tools` down to the top-K most relevant given the recent
 * conversation. Returns `tools` unchanged when:
 *   - retrieval is disabled,
 *   - `top_k` >= tools.length (no point retrieving),
 *   - `env.AI` is absent (dev / test paths),
 *   - the last K messages have no usable content (empty queries).
 */
export async function selectTopKTools(
  tools: Tool[],
  messages: readonly ChatMessage[],
  opts: ToolsRetrievalOpts | null | undefined,
): Promise<Tool[]> {
  if (!opts?.enabled) return tools;
  if (opts.top_k <= 0 || tools.length <= opts.top_k) return tools;

  const ai = getContext()?.env.AI as AiBinding | undefined;
  if (!ai) return tools;

  const recent = messages.slice(-QUERY_TURN_WINDOW);
  const query = recent
    .map((m) => m.content ?? '')
    .filter(Boolean)
    .join('\n')
    .slice(0, QUERY_MAX_CHARS);
  if (!query) return tools;

  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;

  let queryVec: number[];
  try {
    queryVec = await embedOne(ai, model, query);
  } catch {
    return tools;
  }
  if (queryVec.length === 0) return tools;

  const toolVecs = await embedTools(ai, model, tools);

  const scored = tools.map((tool) => {
    const vec = toolVecs.get(tool);
    if (!vec) return { tool, score: -1 };
    return { tool, score: cosineSim(queryVec, vec) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.top_k).map((s) => s.tool);
}

/** Test seam: drop all cached tool embeddings (vitest beforeEach). */
export function _clearToolEmbeddingCache(): void {
  toolEmbeddingCache.clear();
}
