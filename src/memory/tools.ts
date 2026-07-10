/**
 * Memory tools auto-available to any agent whose manifest sets
 * `spec.memory.store: vectorize` — `memory_remember` and `memory_recall`.
 */

import { z } from 'zod';
import { getContext } from '../context';
import { defineTool, type Tool } from '../tools/types';
import { getMemoryStore } from './store';

export function memoryTools(manifestId: string): Tool[] {
  return [
    defineTool({
      name: 'memory_remember',
      description:
        'Persist a fact, preference, or episode to long-term memory so future turns can recall it.',
      args: z.object({
        text: z.string(),
        kind: z.enum(['fact', 'preference', 'episode']).optional(),
      }),
      async handler({ text, kind }) {
        const ctx = getContext();
        if (!ctx) return '[memory error] no request context';
        const store = getMemoryStore(ctx.env, 'vectorize', manifestId);
        const rec = await store.remember(text, kind ?? 'fact');
        return rec ? `remembered (${rec.id})` : '[memory error] failed';
      },
    }),
    defineTool({
      name: 'memory_recall',
      description: 'Recall the top-K memories most relevant to a query.',
      args: z.object({ query: z.string(), k: z.number().int().min(1).max(20).optional() }),
      async handler({ query, k }) {
        const ctx = getContext();
        if (!ctx) return '[memory error] no request context';
        const store = getMemoryStore(ctx.env, 'vectorize', manifestId);
        const out = await store.recall(query, k ?? 5);
        if (out.length === 0) return '[no memories matched]';
        return out.map((m, i) => `${i + 1}. (${m.kind}) ${m.text}`).join('\n');
      },
    }),
  ];
}
