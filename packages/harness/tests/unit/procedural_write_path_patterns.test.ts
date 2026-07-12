/**
 * Procedural memory write path across the patterns that build react.
 *
 * The react loop distills a successful (intent → tool sequence) into
 * memory_vectors (covered by `procedural_write_path.test.ts`). This suite pins
 * that the same write path fires uniformly for the patterns that wrap /
 * build react:
 *
 *   - `deep` forwards `procedural` into its inner react build.
 *   - `reflect` records exactly ONCE per accepted run — not once per react
 *     replay iteration (the inner react is built with procedural writes off
 *     and the reflect wrapper records on the verifier-accepted result).
 *   - `plan_execute` writes on a clean synthesized answer, reconstructing the
 *     executed tool sequence from its subtask outcomes.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { DEFAULT_GUARDRAILS } from '../../src/guardrails/models';
import type { Manifest, Model } from '../../src/manifests/schema';
import { buildDeepAgent } from '../../src/patterns/deep';
import * as modelModule from '../../src/patterns/model';
import { buildPlanExecuteAgent } from '../../src/patterns/plan-execute';
import { buildReflectAgent } from '../../src/patterns/reflect';
import type { ChatMessage } from '../../src/patterns/types';
import { defineTool } from '../../src/tools/types';
import { type CapturedQuery, makeFakeSql } from '../helpers/fake-sql';

const MODEL_SPEC: Model = {
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

const echo = defineTool({
  name: 'echo',
  description: 'echo',
  args: z.object({ text: z.string() }),
  handler: async ({ text }) => text,
});

const TOOL_THEN_FINAL: ChatMessage[] = [
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'tc1', name: 'echo', args: { text: 'x' } }],
  },
  { role: 'assistant', content: 'final answer' },
];

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

/**
 * The fake sql captures every memory_vectors INSERT into `upserts` — one
 * entry per procedural write, mirroring the old MEMORY_VEC.upsert capture.
 */
function ctxWith(env: Env, pending: Promise<unknown>[], upserts: CapturedQuery[]): RequestContext {
  const { sql } = makeFakeSql((q) => {
    if (q.text.includes('INSERT INTO memory_vectors')) upserts.push(q);
    return [];
  });
  return {
    env,
    auth: ANONYMOUS,
    limitState: newLimitState(),
    db: sql,
    execCtx: { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext,
  };
}

async function drive(
  env: Env,
  pending: Promise<unknown>[],
  upserts: CapturedQuery[],
  fn: () => Promise<void>,
): Promise<void> {
  await runWithContext(ctxWith(env, pending, upserts), async () => {
    await fn();
    await Promise.all(pending);
  });
}

/** Pull the metadata object param out of a captured memory_vectors INSERT. */
function insertMetadata(q: CapturedQuery): Record<string, unknown> {
  const metadata = q.params.find(
    (p): p is Record<string, unknown> =>
      typeof p === 'object' && p !== null && !Array.isArray(p) && 'sequence' in p,
  );
  return metadata ?? {};
}

describe('procedural memory write path across patterns', () => {
  it('deep: distills a procedure on a successful tool-using run', async () => {
    const upserts: CapturedQuery[] = [];
    const pending: Promise<unknown>[] = [];
    const env = envForVectors();
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(fakeModel([...TOOL_THEN_FINAL]) as never);
    const agent = buildDeepAgent({
      env,
      modelSpec: MODEL_SPEC,
      tools: [echo],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      procedural: PROCEDURAL_ON,
    });
    await drive(env, pending, upserts, async () => {
      await agent.invoke({ messages: [{ role: 'user', content: 'do the thing' }] });
    });
    vi.restoreAllMocks();
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.params).toContain('procedural');
    expect(upserts[0]!.params).toContain('m');
    expect(String(insertMetadata(upserts[0]!).sequence)).toContain('echo');
  });

  it('reflect: records exactly once per accepted run, not per iteration', async () => {
    const upserts: CapturedQuery[] = [];
    const pending: Promise<unknown>[] = [];
    const env = envForVectors();
    // react model replays the tool→final pair twice (one per reflect
    // iteration); verifier fails iteration 0, passes iteration 1.
    const reactResponses = [...TOOL_THEN_FINAL, ...TOOL_THEN_FINAL];
    const verifierResponses: ChatMessage[] = [
      { role: 'assistant', content: '{"score":0.1,"critique":"redo it"}' },
      { role: 'assistant', content: '{"score":0.9,"critique":"good"}' },
    ];
    let call = 0;
    vi.spyOn(modelModule, 'buildModel').mockImplementation(() => {
      call += 1;
      // #1 is the inner react model, #2 is the verifier.
      return (call === 1 ? fakeModel(reactResponses) : fakeModel(verifierResponses)) as never;
    });
    const agent = buildReflectAgent({
      env,
      modelSpec: MODEL_SPEC,
      tools: [echo],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      procedural: PROCEDURAL_ON,
      primaryModel: MODEL_SPEC,
      reflect: {
        verifier_model: '',
        threshold: 0.5,
        max_iterations: 3,
        criteria: '',
      },
    });
    await drive(env, pending, upserts, async () => {
      await agent.invoke({ messages: [{ role: 'user', content: 'do the thing' }] });
    });
    vi.restoreAllMocks();
    // Two react replays happened, but only the accepted result records.
    expect(upserts).toHaveLength(1);
    expect(String(insertMetadata(upserts[0]!).sequence)).toContain('echo');
  });

  it('plan_execute: writes on a clean synthesized answer', async () => {
    const upserts: CapturedQuery[] = [];
    const pending: Promise<unknown>[] = [];
    const env = envForVectors();
    const plannerResponses: ChatMessage[] = [
      { role: 'assistant', content: '{"plan":[{"id":"s1","description":"do it"}]}' },
      { role: 'assistant', content: 'the synthesized final answer' },
    ];
    let call = 0;
    vi.spyOn(modelModule, 'buildModel').mockImplementation(() => {
      call += 1;
      // #1 is the planner/synthesizer, #2 is the executor react model.
      return (call === 1 ? fakeModel(plannerResponses) : fakeModel([...TOOL_THEN_FINAL])) as never;
    });
    const manifest = {
      spec: { procedural_memory: PROCEDURAL_ON, guardrails: DEFAULT_GUARDRAILS },
    } as unknown as Manifest;
    const agent = buildPlanExecuteAgent({
      env,
      manifest,
      modelSpec: MODEL_SPEC,
      tools: [echo],
      systemPrompt: 'sp',
      manifestId: 'm',
      manifestVersion: '1.0.0',
      primaryModel: MODEL_SPEC,
      planExecute: {
        planner_model: '',
        executor_model: '',
        max_subtasks: 5,
        replan_on_failure: false,
        max_replans: 0,
        executor_recursion_limit: 5,
        planner_few_shots: 0,
      },
    });
    await drive(env, pending, upserts, async () => {
      await agent.invoke({ messages: [{ role: 'user', content: 'do the thing' }] });
    });
    vi.restoreAllMocks();
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.params).toContain('procedural');
    expect(upserts[0]!.params).toContain('m');
    expect(String(insertMetadata(upserts[0]!).sequence)).toContain('echo');
  });
});
