/**
 * `plan_execute` pattern — planner/executor split.
 *
 *   planner model  → emits a structured plan: an ordered list of
 *                    subtasks, each described in plain English plus
 *                    optional tool hints. Output is JSON, parsed by
 *                    `parsePlannerReply`.
 *   executor model → runs one subtask at a time inside a bounded react
 *                    sub-loop with the manifest's tools. Returns the
 *                    final assistant turn + tool-call summary.
 *
 * The two models can have very different shapes — a flagship planner
 * (Sonnet 4.7 / Opus 4) with a cheap executor (Haiku / Llama 3 70B fast),
 * or vice versa. When `spec.procedural_memory.enabled` and
 * `plan_execute.planner_few_shots > 0`, the planner gets a "what worked
 * before" preamble drawn from the same Vectorize index `recall_procedure`
 * uses, filtered to this manifest.
 *
 * Each subtask emits a `plan_step` audit event so an operator can
 * replay how the plan unfolded. Replans (when a subtask fails and
 * `replan_on_failure` is on) emit their own `plan_step` with
 * `status: 'replanned'`. The terminal assistant turn is the planner's
 * synthesis pass over the accumulated subtask outputs.
 *
 * Bounded by three caps that all matter:
 *   - `plan_execute.max_subtasks` — hard cap on subtasks in a single
 *      plan (the planner is told to stay under this).
 *   - `plan_execute.max_replans` — number of times the planner may
 *      revise the plan mid-run.
 *   - `plan_execute.executor_recursion_limit` — per-subtask react cap.
 *      A rogue subtask cannot exhaust the manifest's overall
 *      `recursion_limit`.
 */

import { recordEvent } from '../audit/store';
import { getContext } from '../context';
import type { Env } from '../env';
import { guardFinalResponse } from '../guardrails/final-response';
import { DEFAULT_LIMITS, type Limits } from '../limits/models';
import { currentSignal } from '../limits/state';
import { checkTokenBudget } from '../limits/wrap';
import type { Manifest, Model } from '../manifests/schema';
import { recordCounter } from '../observability/metrics';
import { noopSessionStore, persistFireAndForget } from '../session/do-session';
import { fullReplaySessionStrategy } from '../session/strategies';
import {
  type AppendableEvent,
  chatMessageToEvent,
  type Session,
  type SessionStore,
  type SessionStrategy,
} from '../session/types';
import { buildModel, type ModelClient, recordUsage } from './model';
import { buildReactAgent } from './react';
import { registerPattern } from './registry';
import type { Agent, ChatMessage, InvokeInput, InvokeResult, StreamEvent } from './types';

interface PlannerSubtask {
  id: string;
  description: string;
  tool_hints?: string[];
}

interface PlannerReply {
  plan: PlannerSubtask[];
  rationale?: string;
}

interface PlanExecuteOpts {
  planner_model: string;
  executor_model: string;
  max_subtasks: number;
  replan_on_failure: boolean;
  max_replans: number;
  executor_recursion_limit: number;
  planner_few_shots: number;
}

const PLANNER_SYSTEM_PROMPT =
  'You are the PLANNER stage of a plan-execute agent. ' +
  "Given the user's request and the available tools, decompose the work into ordered " +
  'subtasks for a separate EXECUTOR model. Each subtask must be self-contained — it ' +
  'should describe one concrete action and the expected result. Keep subtasks atomic; ' +
  'the executor will run tools to satisfy each one. Reply ONLY with a JSON object on ' +
  'a single line: {"plan": [{"id": "s1", "description": "…", "tool_hints": ["…"]}, ' +
  '…], "rationale": "<one short paragraph>"}. No prose, no markdown. ' +
  'Tool hints are advisory — the executor still chooses what to call. ' +
  'If a previous attempt produced critiques, use them to revise the plan.';

const SYNTHESIS_SYSTEM_PROMPT =
  'You are the SYNTHESIS stage of a plan-execute agent. Given the original user ' +
  'request and the outputs of every executed subtask, produce ONE final assistant ' +
  'response that directly answers the user. Do NOT list the subtasks back; speak ' +
  'as if you did the work yourself. Be concise. Cite specific numbers or facts the ' +
  'executor returned when relevant.';

/**
 * Strict JSON-with-newlines parser: locates the first `{`, matches its
 * closing `}` accounting for string-escapes, parses that slice.
 * Tolerates leading/trailing prose since smaller planner models often
 * wrap JSON in markdown fences despite the system-prompt instruction.
 */
export function parsePlannerReply(raw: string, maxSubtasks: number): PlannerReply | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { plan?: unknown; rationale?: unknown };
  if (!Array.isArray(obj.plan)) return null;
  const plan: PlannerSubtask[] = [];
  for (let i = 0; i < obj.plan.length && plan.length < maxSubtasks; i += 1) {
    const entry = obj.plan[i] as { id?: unknown; description?: unknown; tool_hints?: unknown };
    if (!entry || typeof entry !== 'object') continue;
    const description = typeof entry.description === 'string' ? entry.description : '';
    if (!description) continue;
    const id = typeof entry.id === 'string' && entry.id ? entry.id : `s${plan.length + 1}`;
    const tool_hints = Array.isArray(entry.tool_hints)
      ? entry.tool_hints.filter((t): t is string => typeof t === 'string')
      : undefined;
    const subtask: PlannerSubtask = { id, description };
    if (tool_hints?.length) subtask.tool_hints = tool_hints;
    plan.push(subtask);
  }
  if (plan.length === 0) return null;
  return {
    plan,
    rationale: typeof obj.rationale === 'string' ? obj.rationale : undefined,
  };
}

interface SubtaskOutcome {
  subtask: PlannerSubtask;
  success: boolean;
  final_text: string;
  tool_calls: string[];
  error?: string;
}

/**
 * Pull up to `topK` past successful procedures for this manifest from
 * Vectorize. Used to prepend a "previous successful plans" preamble to
 * the planner. Returns empty string when the AI binding or Vectorize
 * isn't wired — never throws.
 */
async function fetchPlannerFewShots(
  env: Env,
  tenantId: string,
  manifestId: string,
  topK: number,
  query: string,
  embeddingModel: string,
): Promise<string> {
  if (topK <= 0) return '';
  const ai = env.AI as unknown as
    | { run(model: string, input: { text: string[] }): Promise<unknown> }
    | undefined;
  if (!ai || !env.MEMORY_VEC) return '';
  try {
    const embedded = (await ai.run(embeddingModel, { text: [query.slice(0, 2000)] })) as {
      data?: number[][];
    };
    const vec = embedded.data?.[0];
    if (!vec || vec.length === 0) return '';
    const result = await env.MEMORY_VEC.query(vec, {
      topK,
      returnMetadata: 'all',
      filter: { tenant_id: tenantId, manifest_id: manifestId, kind: 'procedural' },
    });
    const matches = result.matches ?? [];
    if (matches.length === 0) return '';
    const lines = matches.map((m, i) => {
      const meta = m.metadata as { intent?: string; sequence?: string } | undefined;
      return (
        `[past plan ${i + 1}] intent: ${(meta?.intent ?? '').slice(0, 200)}\n` +
        `  successful sequence: ${meta?.sequence ?? '[]'}`
      );
    });
    return `Previous successful plans for this manifest:\n${lines.join('\n')}\n`;
  } catch {
    return '';
  }
}

export interface BuildPlanExecuteOptions {
  env: Env;
  manifest: Manifest;
  modelSpec: Model;
  tools: Parameters<typeof buildReactAgent>[0]['tools'];
  systemPrompt: string;
  manifestId: string;
  manifestVersion: string;
  recursionLimit?: number | null;
  sessionStore?: Parameters<typeof buildReactAgent>[0]['sessionStore'];
  sessionStrategy?: Parameters<typeof buildReactAgent>[0]['sessionStrategy'];
  limits?: Parameters<typeof buildReactAgent>[0]['limits'];
  toolsRetrieval?: Parameters<typeof buildReactAgent>[0]['toolsRetrieval'];
  artifacts?: Parameters<typeof buildReactAgent>[0]['artifacts'];
  planExecute: PlanExecuteOpts;
  primaryModel: Model;
}

export function buildPlanExecuteAgent(opts: BuildPlanExecuteOptions): Agent {
  const planExecute = opts.planExecute;
  const plannerSpec: Model = {
    ...opts.primaryModel,
    id: planExecute.planner_model || opts.primaryModel.id,
  };
  const executorSpec: Model = {
    ...opts.primaryModel,
    id: planExecute.executor_model || opts.primaryModel.id,
  };
  const planner = buildModel(opts.env, plannerSpec);
  const synthesizer = planner;
  const limits: Limits = opts.limits ?? DEFAULT_LIMITS;

  // Parent-level persistence. plan_execute has a single parent thread —
  // like react/reflect, the planner input + final synthesized answer are
  // checkpointed against `input.threadId` so multi-turn conversations keep
  // their history. The executor sub-loops stay stateless (they run without
  // a threadId → NoopSession), so their transient tool chatter never
  // pollutes the parent transcript.
  const sessionStore: SessionStore = opts.sessionStore ?? noopSessionStore;
  const strategy: SessionStrategy = opts.sessionStrategy ?? fullReplaySessionStrategy;

  // The executor is a full react agent — it shares everything from the
  // outer build except the model id and the recursion cap, both of which
  // are scoped down to the per-subtask budget. It is deliberately built
  // WITHOUT a session store: the parent owns persistence, and the executor
  // is always invoked without a threadId (a shared thread would let every
  // subtask race-write the parent's ConversationDO).
  const executor: Agent = buildReactAgent({
    env: opts.env,
    modelSpec: executorSpec,
    tools: opts.tools,
    systemPrompt: opts.systemPrompt,
    manifestId: opts.manifestId,
    manifestVersion: opts.manifestVersion,
    recursionLimit: planExecute.executor_recursion_limit,
    sessionStore: null,
    sessionStrategy: null,
    limits: opts.limits,
    toolsRetrieval: opts.toolsRetrieval ?? null,
    artifacts: opts.artifacts ?? null,
  });

  function persistParent(session: Session, messages: readonly ChatMessage[]): void {
    if (messages.length === 0) return;
    const events: AppendableEvent[] = messages
      .filter((m) => m.role !== 'system')
      .map(chatMessageToEvent);
    persistFireAndForget(session, events, { manifestId: opts.manifestId });
  }

  function toolCatalogDescription(): string {
    if (opts.tools.length === 0) return '(no tools)';
    return opts.tools.map((t) => `- ${t.name}: ${t.description ?? '(no description)'}`).join('\n');
  }

  async function callPlanner(
    userGoal: string,
    fewShotsPreamble: string,
    priorAttempt: { plan: PlannerSubtask[]; critique: string } | null,
    conversationContext = '',
  ): Promise<PlannerReply | null> {
    const sections = [
      fewShotsPreamble || null,
      conversationContext
        ? `Conversation so far (for context — the user goal below is the current ask):\n${conversationContext}`
        : null,
      `Available tools (advisory):\n${toolCatalogDescription()}`,
      `Constraint: produce at most ${planExecute.max_subtasks} subtasks.`,
      priorAttempt
        ? `Previous plan that failed:\n${JSON.stringify(priorAttempt.plan, null, 2)}\n\n` +
          `Critique:\n${priorAttempt.critique}\n\n` +
          'Revise — drop or rewrite failed subtasks and adjust the order.'
        : null,
      `User goal: ${userGoal}`,
    ].filter((s): s is string => !!s);
    const userPrompt = sections.join('\n\n');
    // Blown token budget short-circuits to "no plan" — the caller surfaces
    // the graceful can't-plan message rather than spending more tokens.
    if (checkTokenBudget(limits, opts.manifestId)) return null;
    const result = await planner.chat(
      [
        { role: 'system', content: PLANNER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      [],
      { signal: currentSignal() },
    );
    recordUsage(result, { manifestId: opts.manifestId, modelId: plannerSpec.id });
    return parsePlannerReply(result.message.content, planExecute.max_subtasks);
  }

  async function runSubtask(
    userGoal: string,
    subtask: PlannerSubtask,
    priorOutcomes: SubtaskOutcome[],
  ): Promise<SubtaskOutcome> {
    const contextLines = priorOutcomes.map(
      (p) =>
        `- ${p.subtask.id} (${p.success ? 'ok' : 'failed'}): ${p.subtask.description}\n` +
        `  result: ${p.final_text.slice(0, 400)}`,
    );
    const hintLine = subtask.tool_hints?.length
      ? `\nTool hints (advisory): ${subtask.tool_hints.join(', ')}`
      : '';
    const executorPrompt =
      `Original user goal: ${userGoal}\n\n` +
      (contextLines.length
        ? `Earlier subtasks already completed:\n${contextLines.join('\n')}\n\n`
        : '') +
      `Your current subtask (${subtask.id}): ${subtask.description}${hintLine}\n\n` +
      'Complete THIS subtask only. Use tools as needed. End with a concise summary ' +
      'of what you did and what you found. Do not attempt subsequent subtasks.';
    let result: InvokeResult;
    try {
      result = await executor.invoke({
        messages: [{ role: 'user', content: executorPrompt }],
      });
    } catch (err) {
      return {
        subtask,
        success: false,
        final_text: '',
        tool_calls: [],
        error: (err as Error).message ?? String(err),
      };
    }
    const toolCalls: string[] = [];
    for (const m of result.messages) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const c of m.tool_calls) toolCalls.push(c.name);
      }
    }
    const finalText = result.final.role === 'assistant' ? result.final.content : '';
    // A terminal that isn't an assistant turn (e.g. fatal tool error)
    // is treated as failure. A short empty assistant turn is also
    // suspicious but the planner gets to decide on replan.
    const success = result.final.role === 'assistant' && finalText.trim().length > 0;
    const outcome: SubtaskOutcome = {
      subtask,
      success,
      final_text: finalText,
      tool_calls: toolCalls,
    };
    if (!success && result.final.role !== 'assistant') {
      outcome.error = result.final.content.slice(0, 500);
    }
    return outcome;
  }

  function recordStep(opts2: {
    planId: string;
    stepId: string;
    status: string;
    toolCalls: string[];
    durationMs: number;
    extra?: Record<string, unknown>;
  }): void {
    const ctx = getContext();
    if (!ctx) return;
    recordEvent({
      tenantId: ctx.auth.principal.tenantId,
      eventType: 'plan_step',
      principalSubject: ctx.auth.principal.subject,
      manifestId: opts.manifestId,
      status: opts2.status,
      payload: {
        source: 'plan_execute',
        plan_id: opts2.planId,
        step_id: opts2.stepId,
        executor_model: executorSpec.id,
        tool_calls: opts2.toolCalls,
        tool_call_count: opts2.toolCalls.length,
        duration_ms: opts2.durationMs,
        ...(opts2.extra ?? {}),
      },
    });
    recordCounter('orchestrator_plan_steps', {
      manifest_id: opts.manifestId,
      status: opts2.status,
    });
  }

  async function synthesize(
    userGoal: string,
    outcomes: SubtaskOutcome[],
    synthClient: ModelClient,
  ): Promise<string> {
    const summary = outcomes
      .map(
        (o) =>
          `- ${o.subtask.id} (${o.success ? 'ok' : 'failed'}): ${o.subtask.description}\n` +
          `  output: ${o.final_text.slice(0, 1000)}` +
          (o.error ? `\n  error: ${o.error}` : ''),
      )
      .join('\n');
    // If the budget is already exhausted, surface the deny string as the
    // synthesized answer instead of spending another model call.
    const preDeny = checkTokenBudget(limits, opts.manifestId);
    if (preDeny) return preDeny;
    const result = await synthClient.chat(
      [
        { role: 'system', content: SYNTHESIS_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `User goal: ${userGoal}\n\nSubtask results:\n${summary}`,
        },
      ],
      [],
      { signal: currentSignal() },
    );
    recordUsage(result, { manifestId: opts.manifestId, modelId: plannerSpec.id });
    return result.message.content;
  }

  return {
    tools: executor.tools,
    pattern: 'plan_execute',
    manifestId: opts.manifestId,
    manifestVersion: opts.manifestVersion,

    async invoke(input: InvokeInput): Promise<InvokeResult> {
      const ctx = getContext();
      const tenantId = ctx?.auth.principal.tenantId ?? 'default';
      // Open the parent session and hydrate prior turns for this thread so a
      // continuation carries context into the planner. `render` reads before
      // we persist the new caller turn, matching react's ordering.
      const session = sessionStore.open(input.threadId ?? '');
      const rendered = await strategy.render(session, input.messages, {
        systemPrompt: opts.systemPrompt,
        model: planner,
      });
      // Persist the new caller-supplied turns up front (system dropped) so a
      // mid-run eviction still leaves the user's turn on disk.
      persistParent(session, input.messages);

      const priorTurns = rendered.filter((m) => m.role !== 'system');
      const incomingCount = input.messages.filter((m) => m.role !== 'system').length;
      // Everything before the current caller turn(s) is prior conversation.
      const historyTurns = priorTurns.slice(0, Math.max(0, priorTurns.length - incomingCount));
      const conversationContext = historyTurns
        .map((m) => `${m.role}: ${(m.content ?? '').slice(0, 800)}`)
        .join('\n');
      // The latest user turn is the concrete goal; earlier turns are context.
      const userGoal =
        [...priorTurns].reverse().find((m) => m.role === 'user')?.content ??
        input.messages.find((m) => m.role === 'user')?.content ??
        '';
      const planId = `plan_${crypto.randomUUID().slice(0, 8)}`;
      const fewShotsPreamble =
        opts.manifest.spec.procedural_memory.enabled && planExecute.planner_few_shots > 0
          ? await fetchPlannerFewShots(
              opts.env,
              tenantId,
              opts.manifestId,
              planExecute.planner_few_shots,
              userGoal,
              opts.manifest.spec.procedural_memory.embedding_model,
            )
          : '';

      const allOutcomes: SubtaskOutcome[] = [];
      let plan = await callPlanner(userGoal, fewShotsPreamble, null, conversationContext);
      let replansUsed = 0;
      let plannerFailed = false;
      if (!plan) {
        plannerFailed = true;
        recordStep({
          planId,
          stepId: 'plan',
          status: 'error',
          toolCalls: [],
          durationMs: 0,
          extra: { error: 'planner produced no parseable plan' },
        });
      } else {
        recordStep({
          planId,
          stepId: 'plan',
          status: 'ok',
          toolCalls: [],
          durationMs: 0,
          extra: { subtask_count: plan.plan.length, rationale: plan.rationale ?? '' },
        });
      }

      while (plan && !plannerFailed) {
        let failedSubtask: SubtaskOutcome | null = null;
        for (const subtask of plan.plan) {
          const started = Date.now();
          const outcome = await runSubtask(userGoal, subtask, allOutcomes);
          recordStep({
            planId,
            stepId: subtask.id,
            status: outcome.success ? 'ok' : 'error',
            toolCalls: outcome.tool_calls,
            durationMs: Date.now() - started,
            extra: outcome.error ? { error: outcome.error.slice(0, 500) } : {},
          });
          allOutcomes.push(outcome);
          if (!outcome.success) {
            failedSubtask = outcome;
            break;
          }
        }
        if (!failedSubtask) break;
        if (!planExecute.replan_on_failure || replansUsed >= planExecute.max_replans) {
          break;
        }
        replansUsed += 1;
        const critique =
          `Subtask ${failedSubtask.subtask.id} failed: ${failedSubtask.error ?? 'no assistant turn'}\n` +
          `Remaining work after this point should be re-planned given the partial results above.`;
        const revised = await callPlanner(
          userGoal,
          fewShotsPreamble,
          { plan: plan.plan, critique },
          conversationContext,
        );
        if (!revised) {
          recordStep({
            planId,
            stepId: `replan_${replansUsed}`,
            status: 'error',
            toolCalls: [],
            durationMs: 0,
            extra: { error: 'replanner produced no parseable plan' },
          });
          break;
        }
        recordStep({
          planId,
          stepId: `replan_${replansUsed}`,
          status: 'replanned',
          toolCalls: [],
          durationMs: 0,
          extra: { subtask_count: revised.plan.length, rationale: revised.rationale ?? '' },
        });
        plan = revised;
      }

      // Synthesis. Even when the plan failed mid-way, the synthesizer
      // gets to produce the user-facing answer — better to surface
      // partial results than to drop the whole turn.
      const finalText = plannerFailed
        ? 'I could not produce a plan for this request. Could you rephrase or break the task into smaller asks?'
        : await synthesize(userGoal, allOutcomes, synthesizer);

      // Guard the synthesizer's user-facing answer (no-op unless
      // `final_response` is a guardrails target). plan_execute's `streamEvents`
      // delegates to `invoke`, so guarding here covers both paths.
      const final = await guardFinalResponse(
        { role: 'assistant', content: finalText },
        opts.manifest.spec.guardrails,
        opts.manifestId,
      );
      // Persist the synthesized answer to the parent thread (guard-then-persist,
      // matching react) so the next invocation on this threadId sees it.
      persistParent(session, [final]);
      const messages: ChatMessage[] = [...priorTurns, final];
      recordStep({
        planId,
        stepId: 'synthesis',
        status: plannerFailed ? 'error' : 'ok',
        toolCalls: allOutcomes.flatMap((o) => o.tool_calls),
        durationMs: 0,
        extra: { subtask_count: allOutcomes.length, replans_used: replansUsed },
      });
      return { messages, final };
    },

    async *streamEvents(input: InvokeInput): AsyncGenerator<StreamEvent> {
      // v1: delegate to invoke() and emit one terminal event. Real
      // mid-plan streaming would interleave subtask deltas which makes
      // the per-step on_tool_start/on_tool_end events hard to parse.
      const result = await this.invoke(input);
      // Surface each subtask as a synthetic tool boundary so a watching
      // UI can show progress as the plan unfolds. We can't surface real
      // streaming until we rework executor.invoke into streamEvents.
      for (const m of result.messages) {
        if (m.role === 'assistant' && m.tool_calls) {
          for (const c of m.tool_calls) {
            yield {
              event: 'on_tool_start',
              data: { name: c.name, input: c.args },
            };
            yield {
              event: 'on_tool_end',
              data: { name: c.name, output: '' },
            };
          }
        }
      }
      yield { event: 'on_chain_end', data: { output: result } };
    },
  };
}

registerPattern('plan_execute', (ctx) =>
  buildPlanExecuteAgent({
    env: ctx.env,
    manifest: ctx.manifest,
    modelSpec: ctx.modelSpec,
    tools: ctx.tools,
    systemPrompt: ctx.systemPrompt,
    manifestId: ctx.manifestId,
    manifestVersion: ctx.manifestVersion,
    recursionLimit: ctx.recursionLimit ?? null,
    sessionStore: ctx.sessionStore ?? null,
    sessionStrategy: ctx.sessionStrategy ?? null,
    limits: ctx.limits,
    toolsRetrieval: ctx.manifest.spec.tools_retrieval,
    artifacts: ctx.manifest.spec.artifacts,
    primaryModel: ctx.modelSpec,
    planExecute: ctx.manifest.spec.plan_execute,
  }),
);
