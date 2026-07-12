/**
 * Regression: procedural memory had no write path. `storeProcedure`
 * (memory/procedural.ts) had ZERO call sites, so `procedural_memory.enabled`
 * — and the `recall_procedure` tool that reads the index — were non-functional
 * (the schema docstring even claims the react loop stores successful pairs
 * after each run, which was false).
 *
 * Pins:
 *   1. A clean end-of-turn success whose transcript contains a tool-call
 *      sequence distills (intent → sequence) into memory_vectors when
 *      procedural memory is enabled.
 *   2. Disabled procedural memory writes nothing.
 *   3. A run with no tool calls writes nothing (no procedure to remember).
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import * as modelModule from '../../src/patterns/model';
import { buildReactAgent } from '../../src/patterns/react';
import type { ChatMessage } from '../../src/patterns/types';
import { defineTool } from '../../src/tools/types';
import { type CapturedQuery, makeFakeSql } from '../helpers/fake-sql';

const MODEL_SPEC = {
  id: null,
  temperature: 0,
  max_tokens: null,
  region: null,
  cache: false,
  thinking_budget: null,
  fallbacks: [] as string[],
  confidence_escalation: {
    enabled: false,
    escalate_to: '',
    low_confidence_markers: [] as string[],
    min_response_chars: 40,
  },
};

const PROCEDURAL_ON = { enabled: true, top_k: 3, embedding_model: '@cf/baai/bge-base-en-v1.5' };

function fakeModel(responses: ChatMessage[]) {
  return {
    modelId: 'stub',
    route: { provider: 'anthropic', model: 'stub' } as const,
    async chat() {
      const next = responses.shift();
      if (!next) throw new Error('out of stubbed responses');
      const stopReason = next.tool_calls?.length ? 'tool_use' : 'end_turn';
      return { message: next, stopReason: stopReason as 'tool_use' | 'end_turn' };
    },
    async *streamChat() {},
  };
}

const echo = defineTool({
  name: 'echo',
  description: 'echo',
  args: z.object({ text: z.string() }),
  handler: async ({ text }) => text,
});

function envForVectors(): Env {
  return {
    AI: {
      async run() {
        return { data: [[0.1, 0.2, 0.3]] };
      },
    },
    HYPERDRIVE: { connectionString: 'postgresql://fake' },
  } as unknown as Env;
}

function ctxWith(env: Env, pending: Promise<unknown>[], queries: CapturedQuery[]): RequestContext {
  const { sql } = makeFakeSql((q) => {
    queries.push(q);
    return [];
  });
  return {
    env,
    auth: ANONYMOUS,
    limitState: newLimitState(),
    db: sql,
    // Collect fire-and-forget work so the test can await it deterministically.
    execCtx: { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext,
  };
}

async function runOnce(
  procedural: typeof PROCEDURAL_ON | { enabled: false; top_k: number; embedding_model: string },
  responses: ChatMessage[],
): Promise<CapturedQuery[]> {
  const queries: CapturedQuery[] = [];
  const pending: Promise<unknown>[] = [];
  const env = envForVectors();
  vi.spyOn(modelModule, 'buildModel').mockReturnValue(fakeModel(responses) as never);
  const agent = buildReactAgent({
    env,
    modelSpec: MODEL_SPEC,
    tools: [echo],
    systemPrompt: 'sp',
    manifestId: 'm',
    manifestVersion: '1.0.0',
    procedural,
  });
  await runWithContext(ctxWith(env, pending, queries), async () => {
    await agent.invoke({ messages: [{ role: 'user', content: 'do the thing' }] });
    await Promise.all(pending);
  });
  vi.restoreAllMocks();
  return queries.filter((q) => q.text.includes('INSERT INTO memory_vectors'));
}

const TOOL_THEN_FINAL: ChatMessage[] = [
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'tc1', name: 'echo', args: { text: 'x' } }],
  },
  { role: 'assistant', content: 'final answer' },
];

describe('procedural memory write path', () => {
  it('distills (intent → tool sequence) on a successful tool-using run', async () => {
    const upserts = await runOnce(PROCEDURAL_ON, [...TOOL_THEN_FINAL]);
    expect(upserts).toHaveLength(1);
    // Scope columns: tenant + kind + manifest; sequence lands in metadata.
    expect(upserts[0]!.params).toContain('procedural');
    expect(upserts[0]!.params).toContain('m');
    const metadata = upserts[0]!.params.find(
      (p): p is Record<string, unknown> => typeof p === 'object' && p !== null && 'sequence' in p,
    );
    expect(String(metadata?.sequence)).toContain('echo');
  });

  it('writes nothing when procedural memory is disabled', async () => {
    const upserts = await runOnce(
      { enabled: false, top_k: 3, embedding_model: '@cf/baai/bge-base-en-v1.5' },
      [...TOOL_THEN_FINAL],
    );
    expect(upserts).toHaveLength(0);
  });

  it('writes nothing when the run made no tool calls', async () => {
    const upserts = await runOnce(PROCEDURAL_ON, [
      { role: 'assistant', content: 'just an answer' },
    ]);
    expect(upserts).toHaveLength(0);
  });
});
