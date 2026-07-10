/**
 * Eval judge — scores a candidate response against a `Rubric`.
 *
 * Layered evaluation:
 *
 *   1. Deterministic gates first — `must_include` / `must_not_include`.
 *      A fail here short-circuits before any model call so cheap,
 *      observable misses cost zero tokens.
 *   2. Workers-AI semantic judge — when `criteria` is non-empty, the
 *      response is scored against it by `env.AI` (no AI Gateway tokens,
 *      runs on the same isolate). Output is parsed as JSON; a malformed
 *      reply degrades to score 0 with the raw text as reasoning so the
 *      run completes instead of throwing.
 *
 * The `Judge` interface is pluggable so tests substitute a deterministic
 * implementation that doesn't need an AI binding, and future phases can
 * swap in alternate judge models without touching the runner.
 */

import type { Env } from '../env';
import type { Rubric } from './types';

export interface JudgeInput {
  userInput: string;
  response: string;
  rubric: Rubric;
}

export interface JudgeResult {
  score: number;
  verdict: 'pass' | 'fail';
  reasoning: string;
}

export interface Judge {
  evaluate(input: JudgeInput): Promise<JudgeResult>;
}

/**
 * Deterministic substring gates. Runs before any model call; returns a
 * fail with the offending substring when triggered, otherwise null so
 * the caller can fall through to the semantic judge.
 */
function applyDeterministicGates(input: JudgeInput): JudgeResult | null {
  const haystack = input.response.toLowerCase();
  for (const needle of input.rubric.must_include) {
    if (!haystack.includes(needle.toLowerCase())) {
      return {
        score: 0,
        verdict: 'fail',
        reasoning: `missing required substring: "${needle}"`,
      };
    }
  }
  for (const needle of input.rubric.must_not_include) {
    if (haystack.includes(needle.toLowerCase())) {
      return {
        score: 0,
        verdict: 'fail',
        reasoning: `contained forbidden substring: "${needle}"`,
      };
    }
  }
  return null;
}

const JUDGE_SYSTEM_PROMPT =
  'You are an evaluator. Score a response from 0.0 to 1.0 based on whether it satisfies ' +
  'the criteria. Be strict but fair. Reply with ONLY a JSON object on a single line: ' +
  '{"score": <float between 0 and 1>, "reasoning": "<one sentence>"}. No prose, no markdown.';

function buildJudgePrompt(input: JudgeInput): string {
  return [
    `Question: ${input.userInput}`,
    `Response: ${input.response}`,
    `Criteria: ${input.rubric.criteria}`,
  ].join('\n\n');
}

interface ParsedJudgeReply {
  score: number;
  reasoning: string;
}

function parseJudgeReply(raw: string): ParsedJudgeReply | null {
  // The model can wrap JSON in code fences or whitespace despite the
  // system prompt; pull the first `{ ... }` block defensively.
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { score?: unknown; reasoning?: unknown };
    const score = typeof obj.score === 'number' ? obj.score : Number(obj.score);
    if (!Number.isFinite(score)) return null;
    const clamped = Math.max(0, Math.min(1, score));
    const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
    return { score: clamped, reasoning };
  } catch {
    return null;
  }
}

/**
 * Workers-AI-backed judge. Uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
 * by default — large enough to score nuanced criteria, small enough to
 * keep eval runs cheap. The binding is consulted lazily so unit tests
 * that don't wire `env.AI` can still construct a judge instance.
 */
export function workersAiJudge(env: Env, opts: { model?: string } = {}): Judge {
  const modelId = opts.model ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  return {
    async evaluate(input: JudgeInput): Promise<JudgeResult> {
      const gateResult = applyDeterministicGates(input);
      if (gateResult) return gateResult;

      const threshold = input.rubric.pass_threshold;
      if (!input.rubric.criteria) {
        return {
          score: 1,
          verdict: threshold <= 1 ? 'pass' : 'fail',
          reasoning: 'no semantic criteria; deterministic gates passed',
        };
      }

      if (!env.AI) {
        return {
          score: 0,
          verdict: 'fail',
          reasoning: 'judge unavailable: AI binding is not wired in this environment',
        };
      }

      try {
        const reply = (await env.AI.run(modelId, {
          messages: [
            { role: 'system', content: JUDGE_SYSTEM_PROMPT },
            { role: 'user', content: buildJudgePrompt(input) },
          ],
          max_tokens: 200,
          temperature: 0,
        })) as { response?: string };
        const text = reply.response ?? '';
        const parsed = parseJudgeReply(text);
        if (!parsed) {
          return {
            score: 0,
            verdict: 'fail',
            reasoning: `judge returned unparseable reply: ${text.slice(0, 200)}`,
          };
        }
        return {
          score: parsed.score,
          verdict: parsed.score >= threshold ? 'pass' : 'fail',
          reasoning: parsed.reasoning || 'no reasoning supplied',
        };
      } catch (err) {
        return {
          score: 0,
          verdict: 'fail',
          reasoning: `judge call failed: ${(err as Error).message ?? String(err)}`,
        };
      }
    },
  };
}

/**
 * Deterministic-only judge — applies must_include / must_not_include
 * gates and treats `criteria` as auto-pass. Used by tests that don't
 * want an AI binding in the loop; also a sensible fallback when
 * `env.AI` quotas are exhausted.
 */
export function deterministicJudge(): Judge {
  return {
    async evaluate(input: JudgeInput): Promise<JudgeResult> {
      const gateResult = applyDeterministicGates(input);
      if (gateResult) return gateResult;
      return {
        score: 1,
        verdict: 'pass',
        reasoning: 'deterministic-only judge — all substring gates passed',
      };
    },
  };
}

export type PanelAggregator = 'median' | 'mean' | 'min';

/**
 * Run N judges in parallel and aggregate their scores. Mirrors
 * Cursor's "panel of judges" approach — variance reduction against a
 * single model's biases (sycophancy, self-preference, length-bias).
 *
 * Default aggregator is `median`: robust to one outlier-low or
 * outlier-high judge. `min` is the strictest (any judge fails → fail);
 * `mean` is the most lenient.
 *
 * The reasoning field concatenates every judge's reasoning so an
 * operator can trace which judge moved the score.
 */
export function panelJudge(judges: Judge[], opts: { aggregator?: PanelAggregator } = {}): Judge {
  if (judges.length === 0) {
    throw new Error('panelJudge requires at least one judge');
  }
  const aggregator = opts.aggregator ?? 'median';
  return {
    async evaluate(input: JudgeInput): Promise<JudgeResult> {
      const verdicts = await Promise.all(judges.map((j) => j.evaluate(input)));
      const scores = verdicts.map((v) => v.score).sort((a, b) => a - b);
      let aggregated: number;
      switch (aggregator) {
        case 'mean':
          aggregated = scores.reduce((a, b) => a + b, 0) / scores.length;
          break;
        case 'min':
          aggregated = scores[0]!;
          break;
        default: {
          const mid = scores.length / 2;
          aggregated = Number.isInteger(mid)
            ? (scores[mid - 1]! + scores[mid]!) / 2
            : scores[Math.floor(mid)]!;
        }
      }
      const threshold = input.rubric.pass_threshold;
      const reasoning = verdicts
        .map((v, i) => `[j${i} score=${v.score.toFixed(2)}] ${v.reasoning}`)
        .join(' | ');
      return {
        score: aggregated,
        verdict: aggregated >= threshold ? 'pass' : 'fail',
        reasoning,
      };
    },
  };
}
