/**
 * plan_execute pattern — planner/executor split.
 *
 * Pins:
 *   1. parsePlannerReply tolerates leading prose / trailing fence, caps at maxSubtasks.
 *   2. Successful plan flows planner → executor (per subtask) → synthesizer; final
 *      assistant turn is the synthesizer's text.
 *   3. Unparseable planner reply short-circuits with an apology message — no
 *      executor calls.
 *   4. Subtask failure with replan_on_failure=true triggers a planner re-call;
 *      the second plan's subtasks run.
 *   5. Subtask failure with replan_on_failure=false aborts the plan but synthesis
 *      still produces a user-facing turn over partial outcomes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import type { Manifest, Model } from '../../src/manifests/schema';
import * as modelModule from '../../src/patterns/model';
import { buildPlanExecuteAgent, parsePlannerReply } from '../../src/patterns/plan-execute';
import * as reactModule from '../../src/patterns/react';
import type { Agent, ChatMessage, InvokeInput, InvokeResult } from '../../src/patterns/types';

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
    low_confidence_markers: [],
    min_response_chars: 40,
  },
};

const PLAN_EXECUTE_OPTS = {
  planner_model: '',
  executor_model: '',
  max_subtasks: 5,
  replan_on_failure: true,
  max_replans: 2,
  executor_recursion_limit: 4,
  planner_few_shots: 0,
};

function ctx(): RequestContext {
  return { env: {} as Env, auth: ANONYMOUS, limitState: newLimitState() };
}

function fakeExecutor(replies: string[]): Agent {
  return {
    tools: [],
    pattern: 'react',
    manifestId: 'fake',
    manifestVersion: '1.0.0',
    async invoke(input: InvokeInput): Promise<InvokeResult> {
      const reply = replies.shift() ?? 'no more replies';
      const final: ChatMessage = { role: 'assistant', content: reply };
      return { messages: [...input.messages, final], final };
    },
    async *streamEvents() {},
  };
}

interface FakeReply {
  content: string;
}

/**
 * Stateful planner/synthesizer stub. `buildModel` is called twice in
 * the plan_execute build (planner, synthesizer); both reuse the same
 * ModelClient. Replies are dispensed in invocation order.
 */
function fakeModel(replies: FakeReply[]) {
  return {
    modelId: 'fake',
    route: { provider: 'fake', model: 'fake' } as const,
    async chat() {
      const r = replies.shift() ?? { content: '' };
      return {
        message: { role: 'assistant' as const, content: r.content },
        stopReason: 'end_turn' as const,
      };
    },
    async *streamChat() {
      yield '';
      return {
        message: { role: 'assistant' as const, content: '' },
        stopReason: 'end_turn' as const,
      };
    },
  };
}

function buildArgs(): Parameters<typeof buildPlanExecuteAgent>[0] {
  return {
    env: {} as Env,
    manifest: {
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'test', version: '1.0.0' },
      spec: {
        procedural_memory: { enabled: false, top_k: 3, embedding_model: 'bge' },
      },
    } as unknown as Manifest,
    modelSpec: MODEL_SPEC,
    tools: [],
    systemPrompt: 'sp',
    manifestId: 'test',
    manifestVersion: '1.0.0',
    primaryModel: MODEL_SPEC,
    planExecute: PLAN_EXECUTE_OPTS,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parsePlannerReply', () => {
  it('parses a clean reply', () => {
    const result = parsePlannerReply(
      '{"plan": [{"id": "s1", "description": "lookup"}], "rationale": "small task"}',
      8,
    );
    expect(result?.plan).toHaveLength(1);
    expect(result?.plan[0]?.id).toBe('s1');
    expect(result?.rationale).toBe('small task');
  });

  it('tolerates leading prose and trailing markdown fence', () => {
    const raw =
      "Here's the plan:\n```json\n" +
      '{"plan":[{"id":"a","description":"step a"},{"id":"b","description":"step b"}]}' +
      '\n```\nThat should do it.';
    const result = parsePlannerReply(raw, 8);
    expect(result?.plan.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('caps at maxSubtasks', () => {
    const subtasks = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      description: `step ${i}`,
    }));
    const raw = JSON.stringify({ plan: subtasks });
    const result = parsePlannerReply(raw, 5);
    expect(result?.plan).toHaveLength(5);
  });

  it('rejects no-{} input', () => {
    expect(parsePlannerReply('garbage', 5)).toBeNull();
  });

  it('rejects when plan is not an array', () => {
    expect(parsePlannerReply('{"plan": "not an array"}', 5)).toBeNull();
  });

  it('rejects empty plan', () => {
    expect(parsePlannerReply('{"plan": []}', 5)).toBeNull();
  });

  it('skips subtasks with no description', () => {
    const raw = JSON.stringify({
      plan: [{ id: 's1' }, { id: 's2', description: 'real step' }, { description: '' }],
    });
    const result = parsePlannerReply(raw, 8);
    expect(result?.plan).toHaveLength(1);
    expect(result?.plan[0]?.id).toBe('s2');
  });

  it('handles nested braces inside strings', () => {
    const raw = '{"plan":[{"id":"s1","description":"send {literal:braces}"}]}';
    const result = parsePlannerReply(raw, 5);
    expect(result?.plan[0]?.description).toContain('{literal:braces}');
  });
});

describe('buildPlanExecuteAgent', () => {
  it('flows planner → executor per subtask → synthesizer on the happy path', async () => {
    const exec = fakeExecutor(['searched for X', 'summarized the findings']);
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(exec);
    const planner = fakeModel([
      {
        content:
          '{"plan":[{"id":"s1","description":"search"},{"id":"s2","description":"summarize"}]}',
      },
      // synthesizer call
      { content: 'Here is your answer based on the search and summary.' },
    ]);
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(planner as never);

    const wrapped = buildPlanExecuteAgent(buildArgs());
    const result = await runWithContext(ctx(), () =>
      wrapped.invoke({ messages: [{ role: 'user', content: 'tell me about X' }] }),
    );
    expect(result.final.role).toBe('assistant');
    expect(result.final.content).toBe('Here is your answer based on the search and summary.');
  });

  it('short-circuits with apology when planner reply is unparseable', async () => {
    const exec = fakeExecutor([]);
    const execSpy = vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(exec);
    const planner = fakeModel([{ content: 'I cannot respond as JSON, sorry.' }]);
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(planner as never);

    const wrapped = buildPlanExecuteAgent(buildArgs());
    const invokeSpy = vi.spyOn(exec, 'invoke');
    const result = await runWithContext(ctx(), () =>
      wrapped.invoke({ messages: [{ role: 'user', content: 'q' }] }),
    );
    expect(result.final.content).toContain('could not produce a plan');
    expect(invokeSpy).not.toHaveBeenCalled();
    expect(execSpy).toHaveBeenCalled();
  });

  it('re-calls the planner when a subtask fails and replan_on_failure=true', async () => {
    // First subtask returns empty content (treated as failure) → replan.
    // Second plan's subtask succeeds, then synthesizer runs.
    const exec: Agent = {
      tools: [],
      pattern: 'react',
      manifestId: 'fake',
      manifestVersion: '1.0.0',
      invoke: vi
        .fn()
        .mockResolvedValueOnce({
          messages: [],
          final: { role: 'assistant', content: '' }, // empty → failed
        })
        .mockResolvedValueOnce({
          messages: [],
          final: { role: 'assistant', content: 'recovered work' },
        }),
      async *streamEvents() {},
    };
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(exec);
    const planner = fakeModel([
      { content: '{"plan":[{"id":"s1","description":"first try"}]}' },
      { content: '{"plan":[{"id":"r1","description":"retry try"}]}' },
      { content: 'final synthesis' },
    ]);
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(planner as never);

    const wrapped = buildPlanExecuteAgent(buildArgs());
    const result = await runWithContext(ctx(), () =>
      wrapped.invoke({ messages: [{ role: 'user', content: 'q' }] }),
    );
    expect(result.final.content).toBe('final synthesis');
    expect(exec.invoke).toHaveBeenCalledTimes(2);
  });

  it('skips replan when replan_on_failure=false; synthesis still fires over partials', async () => {
    const exec: Agent = {
      tools: [],
      pattern: 'react',
      manifestId: 'fake',
      manifestVersion: '1.0.0',
      invoke: vi.fn().mockResolvedValueOnce({
        messages: [],
        final: { role: 'assistant', content: '' },
      }),
      async *streamEvents() {},
    };
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(exec);
    const planner = fakeModel([
      { content: '{"plan":[{"id":"s1","description":"only"}]}' },
      { content: 'synthesis over partial' },
    ]);
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(planner as never);

    const args = buildArgs();
    args.planExecute = { ...args.planExecute, replan_on_failure: false };
    const wrapped = buildPlanExecuteAgent(args);
    const result = await runWithContext(ctx(), () =>
      wrapped.invoke({ messages: [{ role: 'user', content: 'q' }] }),
    );
    expect(result.final.content).toBe('synthesis over partial');
    expect(exec.invoke).toHaveBeenCalledTimes(1);
  });

  it('stops replanning at max_replans even when failures persist', async () => {
    const exec: Agent = {
      tools: [],
      pattern: 'react',
      manifestId: 'fake',
      manifestVersion: '1.0.0',
      invoke: vi.fn().mockResolvedValue({
        messages: [],
        final: { role: 'assistant', content: '' },
      }),
      async *streamEvents() {},
    };
    vi.spyOn(reactModule, 'buildReactAgent').mockReturnValue(exec);
    // Plan + 2 replans + synthesis = 4 model calls. Subtask always fails.
    const planner = fakeModel([
      { content: '{"plan":[{"id":"s","description":"try"}]}' },
      { content: '{"plan":[{"id":"s","description":"try again"}]}' },
      { content: '{"plan":[{"id":"s","description":"try once more"}]}' },
      { content: 'synthesis over three failed tries' },
    ]);
    vi.spyOn(modelModule, 'buildModel').mockReturnValue(planner as never);

    const wrapped = buildPlanExecuteAgent(buildArgs());
    const result = await runWithContext(ctx(), () =>
      wrapped.invoke({ messages: [{ role: 'user', content: 'q' }] }),
    );
    expect(result.final.content).toBe('synthesis over three failed tries');
    // 1 plan + 2 replans = 3 plans, each runs the 1 subtask = 3 executor invocations
    expect(exec.invoke).toHaveBeenCalledTimes(3);
  });
});
