/**
 * `tool_call` and `plan_step` are emitted by the react loop and plan tools
 * respectively. Pins the contract:
 *
 *   1. `tool_call` fires once per dispatch with `transport`, `args`, and
 *      either `output_preview` (ok) or `error` (error).
 *   2. `tool_call` is SKIPPED when the executor returns a wrapper deny —
 *      the wrapper already emitted its specific outcome event.
 *   3. Unknown tool name emits `tool_call` with status='error' and
 *      `transport: 'unknown'`.
 *   4. `plan_step` fires from `plan_update_step` with the new step status
 *      and `{ plan_id, step_id, result_present }`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as auditStore from '../../src/audit/store';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { applyGuardrails } from '../../src/guardrails/wrap';
import { applyLimits } from '../../src/limits/wrap';
import * as metricsModule from '../../src/observability/metrics';
import * as modelModule from '../../src/patterns/model';
import { buildReactAgent } from '../../src/patterns/react';
import type { ChatMessage } from '../../src/patterns/types';
import { applyPolicies } from '../../src/policy/wrap';
import { defineTool, defineToolWithExecutor, denyOutput, type Tool } from '../../src/tools/types';

function ctx(env: Env = {} as Env): RequestContext {
  return { env, auth: ANONYMOUS, limitState: newLimitState() };
}

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
    async *streamChat() {
      yield '';
      return { message: { role: 'assistant', content: '' }, stopReason: 'end_turn' as const };
    },
  };
}

function recordedEvents() {
  const events: Array<{ eventType: string; status: string; payload: Record<string, unknown> }> = [];
  vi.spyOn(auditStore, 'recordEvent').mockImplementation((opts) => {
    events.push({
      eventType: opts.eventType,
      status: opts.status ?? '',
      payload: opts.payload ?? {},
    });
    return {
      id: '',
      tenant_id: opts.tenantId,
      ts: 0,
      event_type: opts.eventType,
      manifest_id: opts.manifestId ?? '',
      principal_subject: opts.principalSubject ?? '',
      status: opts.status ?? '',
      payload: opts.payload ?? {},
    };
  });
  return { events };
}

function recordedCounters() {
  const counters: Array<{ name: string; labels: Record<string, unknown>; value: number }> = [];
  vi.spyOn(metricsModule, 'recordCounter').mockImplementation((name, labels = {}, value = 1) => {
    counters.push({ name, labels: labels as Record<string, unknown>, value });
  });
  return { counters };
}

const ok = defineTool({
  name: 'ok',
  description: 'returns ok',
  args: z.object({ text: z.string() }),
  handler: async ({ text }) => `you said: ${text}`,
});

function denyTool(): Tool {
  return defineToolWithExecutor({
    name: 'deny_tool',
    description: 'always denies via a wrapper-shaped output',
    args: z.object({}),
    executor: {
      transport: 'local',
      async execute() {
        return denyOutput('[policy denied] for test', 'policy');
      },
    },
  });
}

function buildAgentWith(tool: Tool, replies: ChatMessage[]) {
  vi.spyOn(modelModule, 'buildModel').mockReturnValue(fakeModel(replies) as never);
  return buildReactAgent({
    env: {} as Env,
    modelSpec: {
      id: null,
      temperature: 0,
      max_tokens: null,
      region: null,
      cache: false,
      thinking_budget: null,
      fallbacks: [],
      confidence_escalation: {
        enabled: false,
        escalate_to: '',
        low_confidence_markers: [],
        min_response_chars: 40,
      },
    },
    tools: [tool],
    systemPrompt: 'sp',
    manifestId: 'm',
    manifestVersion: '1.0.0',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tool_call audit emission', () => {
  it('emits one tool_call with transport=local and ok status on success', async () => {
    const { events } = recordedEvents();
    const { counters } = recordedCounters();
    const agent = buildAgentWith(ok, [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', name: 'ok', args: { text: 'hi' } }],
      },
      { role: 'assistant', content: 'done' },
    ]);
    await runWithContext(ctx(), () =>
      agent.invoke({ messages: [{ role: 'user', content: 'go' }] }),
    );
    const toolCalls = events.filter((e) => e.eventType === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.status).toBe('ok');
    expect(toolCalls[0]!.payload.tool).toBe('ok');
    expect(toolCalls[0]!.payload.transport).toBe('local');
    expect(toolCalls[0]!.payload.args).toEqual({ text: 'hi' });
    expect(String(toolCalls[0]!.payload.output_preview)).toContain('you said: hi');
    expect(typeof toolCalls[0]!.payload.duration_ms).toBe('number');
    // A counter row should fire alongside the audit event with matching labels.
    const tcCounters = counters.filter((c) => c.name === 'orchestrator_tool_calls');
    expect(tcCounters).toHaveLength(1);
    expect(tcCounters[0]!.labels).toMatchObject({
      transport: 'local',
      status: 'ok',
      manifest_id: 'm',
    });
  });

  it('emits status=error when the executor throws', async () => {
    const { events } = recordedEvents();
    const fatal = defineTool({
      name: 'fatal',
      description: '',
      args: z.object({}),
      handler: async () => {
        throw new Error('boom');
      },
    });
    const agent = buildAgentWith(fatal, [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', name: 'fatal', args: {} }],
      },
      { role: 'assistant', content: 'recovered' },
    ]);
    await runWithContext(ctx(), () =>
      agent.invoke({ messages: [{ role: 'user', content: 'go' }] }),
    );
    const toolCalls = events.filter((e) => e.eventType === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.status).toBe('error');
    expect(toolCalls[0]!.payload.error).toBe('boom');
    expect(toolCalls[0]!.payload.transport).toBe('local');
  });

  it('emits transport=unknown for an unknown tool name', async () => {
    const { events } = recordedEvents();
    const agent = buildAgentWith(ok, [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', name: 'no_such_tool', args: {} }],
      },
      { role: 'assistant', content: 'done' },
    ]);
    await runWithContext(ctx(), () =>
      agent.invoke({ messages: [{ role: 'user', content: 'go' }] }),
    );
    const toolCalls = events.filter((e) => e.eventType === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.status).toBe('error');
    expect(toolCalls[0]!.payload.transport).toBe('unknown');
    expect(toolCalls[0]!.payload.error).toBe('unknown tool');
  });

  it('does NOT emit tool_call when the executor returned a wrapper deny', async () => {
    const { events } = recordedEvents();
    const agent = buildAgentWith(denyTool(), [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', name: 'deny_tool', args: {} }],
      },
      { role: 'assistant', content: 'understood' },
    ]);
    await runWithContext(ctx(), () =>
      agent.invoke({ messages: [{ role: 'user', content: 'go' }] }),
    );
    const toolCalls = events.filter((e) => e.eventType === 'tool_call');
    expect(toolCalls).toHaveLength(0);
  });
});

describe('plan_step audit emission', () => {
  it('emits one plan_step with the new step status', async () => {
    const { events } = recordedEvents();
    // Stub the plans store so we don't need a real D1.
    const planStore = await import('../../src/plans/store');
    vi.spyOn(planStore, 'updatePlanStep').mockResolvedValue({
      id: 'p1',
      tenantId: 'default',
      manifestId: '',
      title: 't',
      steps: [{ id: 's1', description: 'd', status: 'in_progress', result: '' }],
      createdAt: 0,
      updatedAt: 0,
    } as never);
    const { planUpdateStep } = await import('../../src/plans/tools');
    await runWithContext(ctx(), () =>
      planUpdateStep.executor.execute({
        plan_id: 'p1',
        step_id: 's1',
        status: 'in_progress',
        result: '',
      }),
    );
    const planSteps = events.filter((e) => e.eventType === 'plan_step');
    expect(planSteps).toHaveLength(1);
    expect(planSteps[0]!.status).toBe('in_progress');
    expect(planSteps[0]!.payload).toMatchObject({
      plan_id: 'p1',
      step_id: 's1',
      result_present: false,
    });
  });

  it('marks result_present=true when a non-empty result is supplied', async () => {
    const { events } = recordedEvents();
    const planStore = await import('../../src/plans/store');
    vi.spyOn(planStore, 'updatePlanStep').mockResolvedValue({
      id: 'p1',
      tenantId: 'default',
      manifestId: '',
      title: 't',
      steps: [{ id: 's1', description: 'd', status: 'completed', result: 'ok' }],
      createdAt: 0,
      updatedAt: 0,
    } as never);
    const { planUpdateStep } = await import('../../src/plans/tools');
    await runWithContext(ctx(), () =>
      planUpdateStep.executor.execute({
        plan_id: 'p1',
        step_id: 's1',
        status: 'completed',
        result: 'final answer',
      }),
    );
    const planSteps = events.filter((e) => e.eventType === 'plan_step');
    expect(planSteps).toHaveLength(1);
    expect(planSteps[0]!.status).toBe('completed');
    expect(planSteps[0]!.payload.result_present).toBe(true);
  });
});

describe('governance wrappers carry transport on audit + counters', () => {
  // A non-local tool surface so wrapper-emitted transport is meaningfully
  // different from `local`. Using `mcp` here exercises the path that audit
  // / observability would slice on when answering "denies by transport."
  function mcpTool(): Tool {
    return defineToolWithExecutor({
      name: 'mcp_thing',
      description: '',
      args: z.object({}),
      executor: {
        transport: 'mcp',
        async execute() {
          return 'ok';
        },
      },
    });
  }

  it('policy_decision (denied) records transport on the event + counter', async () => {
    const { events } = recordedEvents();
    const { counters } = recordedCounters();
    const wrapped = applyPolicies(
      [mcpTool()],
      [{ id: 'p1', description: '', required_scopes: ['need-this'], tools: ['mcp_thing'] }],
      'm',
    );
    await runWithContext(ctx(), () => wrapped[0]!.executor.execute({}));
    const denied = events.find((e) => e.eventType === 'policy_decision');
    expect(denied?.payload.transport).toBe('mcp');
    const counter = counters.find((c) => c.name === 'orchestrator_policy_decisions');
    expect(counter?.labels.transport).toBe('mcp');
  });

  it('limit_exceeded records transport on the event + counter', async () => {
    const { events } = recordedEvents();
    const { counters } = recordedCounters();
    const wrapped = applyLimits(
      [mcpTool()],
      {
        max_tool_calls: 0,
        max_wall_clock_seconds: null,
        max_peer_hops: null,
        max_input_tokens: null,
        max_output_tokens: null,
        precount: false,
      },
      'm',
    );
    await runWithContext(ctx(), () => wrapped[0]!.executor.execute({}));
    const breach = events.find((e) => e.eventType === 'limit_exceeded');
    expect(breach?.payload.transport).toBe('mcp');
    const counter = counters.find((c) => c.name === 'orchestrator_limit_breaches');
    expect(counter?.labels.transport).toBe('mcp');
  });

  it('guardrail_block records transport on the event + counter (output filter)', async () => {
    const { events } = recordedEvents();
    const { counters } = recordedCounters();
    // Tool whose output contains a pattern the PII filter matches.
    const leaky = defineToolWithExecutor({
      name: 'leaky',
      description: '',
      args: z.object({}),
      executor: {
        transport: 'a2a',
        async execute() {
          return 'reach me at foo@example.com';
        },
      },
    });
    const wrapped = applyGuardrails(
      [leaky],
      {
        providers: ['pii'],
        block_on_match: false,
        targets: ['output'],
        final_response: { on_match: 'redact', streaming: 'buffer' },
        judges: [],
      },
      'm',
    );
    await runWithContext(ctx(), () => wrapped[0]!.executor.execute({}));
    const block = events.find((e) => e.eventType === 'guardrail_block');
    expect(block?.payload.transport).toBe('a2a');
    const counter = counters.find((c) => c.name === 'orchestrator_guardrail_blocks');
    expect(counter?.labels.transport).toBe('a2a');
  });
});
