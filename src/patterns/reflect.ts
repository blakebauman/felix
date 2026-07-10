/**
 * `reflect` pattern — verifier loop.
 *
 * Wraps an inner `react` agent with a verifier model. After the
 * react loop produces a final assistant turn, a small verifier model
 * scores it against the user's stated goal. Below threshold, the
 * critique is appended as a synthetic user message and react replays
 * — up to `max_iterations` total passes.
 *
 * Hallucinations and off-mission tangents are dramatically reduced
 * for long-form tasks where a single forward pass is too easy to
 * derail. The cost is N+1 full agent runs in the worst case; in
 * practice most calls converge on iteration 1.
 *
 * The verifier model is configured via `spec.reflect.verifier_model`
 * (defaults to the same logical id as the primary, but you usually
 * want it cheaper — `claude-haiku-4` against a sonnet primary, or
 * `llama-3-fast` against either). Verifier output is parsed as JSON
 * for the same reason the eval judge does — robust scoring.
 *
 * Streaming forwards each iteration's inner react stream live (token
 * deltas + tool events), swallowing that iteration's terminal
 * `on_chain_end` so only the final, verifier-accepted response emits a
 * terminal event. Most calls converge on iteration 1, so the common case
 * streams a single clean draft; when the verifier rolls a run back, the
 * revised draft streams after the first. Token-concatenating clients (the
 * OpenAI-compatible streaming surface) therefore see successive drafts
 * appended; the authoritative answer is always the final `on_chain_end`
 * payload. The verifier reasoning lands in audit only.
 */

import { recordEvent } from '../audit/store';
import { getContext } from '../context';
import { currentSignal } from '../limits/state';
import type { Model } from '../manifests/schema';
import { buildModel } from './model';
import { type BuildReactOptions, buildReactAgent } from './react';
import { registerPattern } from './registry';
import type { Agent, InvokeInput, InvokeResult, StreamEvent } from './types';

export interface ReflectOpts {
  /** Workers-AI / Anthropic / OpenAI logical model id the verifier
   *  uses. Defaults to the primary model id when empty. */
  verifier_model: string;
  /** Below this score the verifier triggers a re-run with critique. */
  threshold: number;
  /** Maximum react passes (1 = no reflection). */
  max_iterations: number;
  /** Free-form criteria the verifier scores against. The primary
   *  goal of the user's first turn is always implicit. */
  criteria: string;
}

const VERIFIER_SYSTEM_PROMPT =
  'You are a strict verifier. Score whether the assistant response satisfies the ' +
  "user's first request given the supplied criteria. Reply ONLY with a JSON object " +
  'on a single line: {"score": <float 0..1>, "critique": "<one short paragraph>"}. ' +
  'No prose, no markdown.';

interface VerifierVerdict {
  score: number;
  critique: string;
  passed: boolean;
}

function parseVerifierReply(raw: string): { score: number; critique: string } | null {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { score?: unknown; critique?: unknown };
    const score = typeof obj.score === 'number' ? obj.score : Number(obj.score);
    if (!Number.isFinite(score)) return null;
    return {
      score: Math.max(0, Math.min(1, score)),
      critique: typeof obj.critique === 'string' ? obj.critique : '',
    };
  } catch {
    return null;
  }
}

/**
 * Build the next iteration's working messages: the prior turn plus a
 * synthetic user turn carrying the verifier critique. Shared by `invoke`
 * and `streamEvents` so the replay contract can't drift between them.
 */
function replayMessages(
  result: InvokeResult,
  critique: string,
  iteration: number,
  maxIterations: number,
): InvokeInput['messages'] {
  return [
    ...result.messages,
    {
      role: 'user',
      content:
        `[reflect critique, iteration ${iteration + 1}/${maxIterations}] ` +
        `${critique}\n\nRevise your prior response to address this.`,
    },
  ];
}

export interface BuildReflectOptions extends BuildReactOptions {
  reflect: ReflectOpts;
  /** Primary model spec — used to derive the verifier model when
   *  `reflect.verifier_model` is empty. */
  primaryModel: Model;
}

export function buildReflectAgent(opts: BuildReflectOptions): Agent {
  const inner = buildReactAgent(opts);
  const reflect = opts.reflect;
  if (reflect.max_iterations <= 1) return inner;

  const verifierSpec: Model = {
    ...opts.primaryModel,
    id: reflect.verifier_model || opts.primaryModel.id,
  };
  // The verifier shares the env / fallback chain with the primary
  // but doesn't load tools, judges, or other heavyweight wrappers.
  // It just chats.
  const verifier = buildModel(opts.env, verifierSpec);

  async function verify(userGoal: string, response: string): Promise<VerifierVerdict> {
    const prompt = [
      `User goal: ${userGoal}`,
      `Response: ${response}`,
      `Criteria: ${reflect.criteria || '(none — use general helpfulness)'}`,
    ].join('\n\n');
    try {
      const result = await verifier.chat(
        [
          { role: 'system', content: VERIFIER_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        [],
        { signal: currentSignal() },
      );
      const parsed = parseVerifierReply(result.message.content);
      if (!parsed) {
        return {
          score: 0,
          critique: `verifier returned unparseable reply: ${result.message.content.slice(0, 200)}`,
          passed: false,
        };
      }
      return {
        score: parsed.score,
        critique: parsed.critique,
        passed: parsed.score >= reflect.threshold,
      };
    } catch (err) {
      // Verifier failure → treat as pass so we don't infinite-loop
      // on a broken binding. The original response stands.
      return {
        score: 1,
        critique: `verifier call failed: ${(err as Error).message ?? String(err)}`,
        passed: true,
      };
    }
  }

  function recordIteration(opts2: {
    manifestId: string;
    iteration: number;
    score: number;
    passed: boolean;
    critique: string;
  }): void {
    const ctx = getContext();
    if (!ctx) return;
    recordEvent({
      tenantId: ctx.auth.principal.tenantId,
      eventType: 'judge_score',
      principalSubject: ctx.auth.principal.subject,
      manifestId: opts2.manifestId,
      status: opts2.passed ? 'pass' : 'fail',
      payload: {
        source: 'reflect',
        iteration: opts2.iteration,
        score: opts2.score,
        critique: opts2.critique.slice(0, 500),
      },
    });
  }

  return {
    tools: inner.tools,
    pattern: `reflect:${inner.pattern}`,
    manifestId: opts.manifestId,
    manifestVersion: opts.manifestVersion,

    async invoke(input: InvokeInput): Promise<InvokeResult> {
      const userGoal = input.messages.find((m) => m.role === 'user')?.content ?? '';
      let workingMessages = input.messages;
      let lastResult: InvokeResult | null = null;
      for (let i = 0; i < reflect.max_iterations; i += 1) {
        const result = await inner.invoke({ ...input, messages: workingMessages });
        lastResult = result;
        if (result.final.role !== 'assistant') return result;
        const verdict = await verify(userGoal, result.final.content);
        recordIteration({
          manifestId: opts.manifestId,
          iteration: i,
          score: verdict.score,
          passed: verdict.passed,
          critique: verdict.critique,
        });
        if (verdict.passed) return result;
        if (i === reflect.max_iterations - 1) return result;
        // Append the critique as a synthetic user turn and replay.
        // The next iteration sees the prior response in `messages` so
        // the model knows what to fix.
        workingMessages = replayMessages(result, verdict.critique, i, reflect.max_iterations);
      }
      return lastResult!;
    },

    async *streamEvents(input: InvokeInput): AsyncGenerator<StreamEvent> {
      const userGoal = input.messages.find((m) => m.role === 'user')?.content ?? '';
      let workingMessages = input.messages;
      let lastResult: InvokeResult | null = null;
      for (let i = 0; i < reflect.max_iterations; i += 1) {
        // Forward the inner react stream live, but capture (and swallow)
        // its terminal on_chain_end — only the final accepted iteration
        // emits a terminal event to the caller.
        let captured: InvokeResult | null = null;
        for await (const ev of inner.streamEvents({ ...input, messages: workingMessages })) {
          if (ev.event === 'on_chain_end') {
            captured = ev.data.output;
            continue;
          }
          yield ev;
        }
        const result: InvokeResult | null = captured ?? lastResult;
        lastResult = result;
        // No assistant turn to verify (tool-only / fatal) — emit terminal and stop.
        if (!result || result.final.role !== 'assistant') {
          if (result) yield { event: 'on_chain_end', data: { output: result } };
          return;
        }
        const verdict = await verify(userGoal, result.final.content);
        recordIteration({
          manifestId: opts.manifestId,
          iteration: i,
          score: verdict.score,
          passed: verdict.passed,
          critique: verdict.critique,
        });
        if (verdict.passed || i === reflect.max_iterations - 1) {
          yield { event: 'on_chain_end', data: { output: result } };
          return;
        }
        workingMessages = replayMessages(result, verdict.critique, i, reflect.max_iterations);
      }
    },
  };
}

registerPattern('reflect', (ctx) =>
  buildReflectAgent({
    env: ctx.env,
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
    reflect: ctx.manifest.spec.reflect,
  }),
);
