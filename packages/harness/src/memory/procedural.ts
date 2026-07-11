/**
 * Procedural memory.
 *
 * After a successful agent run, distill `(user_intent →
 * tool_call_sequence)` into a Vectorize vector and upsert under the
 * tenant's namespace. On future runs, a `recall_procedure(query)`
 * tool retrieves the top-K most similar past successes — the agent
 * gets to see "last time this came up, the sequence that worked was
 * [search → summarize → memory_remember]."
 *
 * The vector namespace reuses the existing `MEMORY_VEC` binding but
 * keys procedural memories under a `procedural:` prefix so semantic
 * memory and procedural memory don't collide. A tenant scopes via
 * the `tenant_id` metadata; cross-tenant retrievals are filtered
 * server-side.
 *
 * The model is taught about `recall_procedure` via the tool
 * description; no system-prompt changes required.
 */

import { z } from 'zod';
import { getContext } from '../context';
import type { Env } from '../env';
import type { ChatMessage } from '../patterns/types';
import { defineTool, type Tool } from '../tools/types';

const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

interface AiBinding {
  run(model: string, input: { text: string[] }): Promise<unknown>;
}

async function embed(ai: AiBinding, model: string, text: string): Promise<number[]> {
  const result = (await ai.run(model, { text: [text] })) as { data?: number[][] };
  return result.data?.[0] ?? [];
}

function procedureKey(tenantId: string, manifestId: string, when: number, nonce: string): string {
  return `procedural:${tenantId}:${manifestId}:${when}:${nonce}`;
}

export interface ProceduralOpts {
  enabled: boolean;
  top_k: number;
  embedding_model: string;
}

export const DEFAULT_PROCEDURAL_OPTS: ProceduralOpts = {
  enabled: false,
  top_k: 3,
  embedding_model: DEFAULT_EMBEDDING_MODEL,
};

/**
 * Extract the tool call sequence + the user intent from an
 * `InvokeResult.messages` and upsert the pair into Vectorize. Called
 * by the react loop right before returning a successful result, so
 * one bad run doesn't pollute the procedural index — only ends-of-
 * turn assistant responses (no tool errors as the terminal) qualify.
 */
export async function storeProcedure(
  env: Env,
  opts: ProceduralOpts,
  args: {
    tenantId: string;
    manifestId: string;
    messages: readonly ChatMessage[];
  },
): Promise<void> {
  if (!opts.enabled) return;
  const userIntent = args.messages.find((m) => m.role === 'user')?.content ?? '';
  if (!userIntent) return;
  const sequence: string[] = [];
  for (const m of args.messages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const call of m.tool_calls) sequence.push(call.name);
  }
  if (sequence.length === 0) return; // nothing procedural to remember
  const ai = env.AI as unknown as AiBinding | undefined;
  if (!ai) return;
  let vec: number[];
  try {
    vec = await embed(ai, opts.embedding_model, userIntent.slice(0, 2000));
  } catch {
    return;
  }
  if (vec.length === 0) return;
  const id = procedureKey(
    args.tenantId,
    args.manifestId,
    Date.now(),
    crypto.randomUUID().slice(0, 8),
  );
  try {
    await env.MEMORY_VEC.upsert([
      {
        id,
        values: vec,
        metadata: {
          tenant_id: args.tenantId,
          manifest_id: args.manifestId,
          kind: 'procedural',
          intent: userIntent.slice(0, 500),
          sequence: JSON.stringify(sequence.slice(0, 50)),
          stored_at: Date.now(),
        },
      },
    ]);
  } catch (err) {
    console.warn('procedural memory upsert failed', (err as Error).message);
  }
}

/**
 * The `recall_procedure` tool: takes a description of what the agent
 * is about to do and returns past similar successes from procedural
 * memory. The model uses these as few-shot examples for tool ordering.
 */
export function recallProcedureTool(opts: ProceduralOpts): Tool {
  return defineTool({
    name: 'recall_procedure',
    description:
      'Recall past successful tool-call sequences for similar tasks. Call this BEFORE ' +
      'planning a multi-step approach to see what worked previously. Returns up to ' +
      `${opts.top_k} past procedures with their intent and tool sequence.`,
    args: z.object({
      query: z
        .string()
        .describe(
          'A description of the current task or user intent. Use the same phrasing the user did.',
        ),
    }),
    handler: async ({ query }) => {
      const ctx = getContext();
      if (!ctx) return '[procedural error] no request context';
      const ai = ctx.env.AI as unknown as AiBinding | undefined;
      if (!ai) return '[procedural unavailable] AI binding not configured';
      let qvec: number[];
      try {
        qvec = await embed(ai, opts.embedding_model, query.slice(0, 2000));
      } catch (err) {
        return `[procedural error] embedding failed: ${(err as Error).message}`;
      }
      if (qvec.length === 0) return '[procedural unavailable] empty embedding';
      const result = await ctx.env.MEMORY_VEC.query(qvec, {
        topK: opts.top_k,
        returnMetadata: 'all',
        filter: {
          tenant_id: ctx.auth.principal.tenantId,
          kind: 'procedural',
        },
      });
      const matches = result.matches ?? [];
      if (matches.length === 0) return '[no past procedures found for this query]';
      const lines = matches.map((m, i) => {
        const meta = m.metadata as { intent?: string; sequence?: string } | undefined;
        return (
          `[${i + 1}] intent: ${(meta?.intent ?? '').slice(0, 200)}\n` +
          `    sequence: ${meta?.sequence ?? '[]'}`
        );
      });
      return lines.join('\n');
    },
  });
}
