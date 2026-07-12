/**
 * Continuous eval — online benchmarking of in-flight canaries.
 *
 * The on-demand eval harness (`src/eval/runner.ts`) drives a curated
 * golden set through a candidate manifest. Continuous eval is its
 * production-traffic counterpart, in the shape of Cursor's "online
 * benchmarking": every cron tick it
 *
 *   1. finds every manifest with a canary in flight (`listActiveCanaries`),
 *   2. samples recent *real* production inputs that hit that manifest —
 *      captured as `user_input` on each `tool_call` audit row by the react
 *      loop — within the last `window_ms`,
 *   3. replays each sampled input through the **canary version** of the
 *      manifest (built directly from the versioned manifest, not via the
 *      stable/canary resolver, so the candidate is always exercised),
 *   4. scores the response with the Workers-AI judge against a generic
 *      quality rubric — there is no golden answer for arbitrary production
 *      inputs, so a regression surfaces as a drop in the canary's pass rate
 *      relative to its stable baseline, and
 *   5. emits a `judge_score` audit event tagged `payload.source: 'continuous'`
 *      under the canary's own tenant so an operator sees it in `/audit`
 *      next to the on-demand eval scores.
 *
 * Statelessness: sampling is a time window (`ts >= now - window_ms`) sized
 * to the cron cadence, exactly like the anomaly detector — no cursor table.
 * Which inputs get sampled is a deterministic hash of the input string, so
 * the same recurring query is consistently in or out of the sample across
 * ticks (stable online benchmarking) without persisting a seed.
 *
 * Tenant isolation: the sampled inputs are tenant A's real production text.
 * Each replay therefore runs under a context scoped to the canary's *own*
 * tenant (`canary.tenant_id`), never the anonymous `default` tenant — so the
 * incidental `tool_call` rows the react loop emits during replay (which carry
 * the sampled `user_input`, the derived `args`, and an `output_preview`) stay
 * inside the tenant that already owns that data, instead of leaking tenant-A
 * text into `default`'s audit log where any `audit:read` holder could see it.
 *
 * Loop safety: because replays now land under the canary's tenant (an active
 * canary tenant the sampler *does* scan), each replay context sets
 * `replay: true` so the react loop stamps `replay: true` onto those tool_call
 * rows and `sampleInputs` excludes them — otherwise a replay's own input would
 * be re-sampled on the next tick (an infinite feedback loop). Each replay also
 * gets a fresh `LimitState` so one candidate's token budget can't bleed into
 * the next.
 */

import { recordEventDetached } from '../audit/store';
import {
  buildAnonymousContext,
  disposeLimitState,
  type RequestContext,
  runWithContext,
} from '../context';
import type { Env } from '../env';
import { type Judge, workersAiJudge } from '../eval/judge';
import type { Rubric } from '../eval/types';
import { buildAgent } from '../manifests/builder';
import { type ActiveCanary, getVersion, listActiveCanaries } from '../manifests/store';
import { recordCounter } from '../observability/metrics';
import type { ToolProvider } from '../tools/provider';

export interface ContinuousEvalOpts {
  /** Fraction of distinct recent inputs to replay (deterministic hash gate). */
  sample_rate: number;
  /** Hard cap on replays per cron tick across all canaries — bounds AI Gateway spend. */
  max_replays_per_tick: number;
  /** How far back to sample tool_call rows. Size to the cron cadence. */
  window_ms: number;
}

export const DEFAULT_CONTINUOUS_EVAL_OPTS: ContinuousEvalOpts = {
  sample_rate: 0.01,
  max_replays_per_tick: 10,
  // Match the 10-minute cron cadence so each row is seen ~once.
  window_ms: 10 * 60 * 1000,
};

/** Absolute ceilings so a fat-fingered override can't bankrupt the AI Gateway budget. */
const MAX_REPLAYS_CEILING = 200;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the per-tick knobs from the optional `CONTINUOUS_EVAL` env var
 * (JSON). Each field is validated and clamped independently; anything
 * missing or out of range falls back to `DEFAULT_CONTINUOUS_EVAL_OPTS`,
 * so a malformed override degrades to defaults rather than disabling the
 * job or blowing the budget.
 */
export function parseContinuousEvalOpts(env: Env): ContinuousEvalOpts {
  const d = DEFAULT_CONTINUOUS_EVAL_OPTS;
  if (!env.CONTINUOUS_EVAL) return d;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(env.CONTINUOUS_EVAL) as Record<string, unknown>;
  } catch {
    return d;
  }
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const sample = num(raw.sample_rate);
  const replays = num(raw.max_replays_per_tick);
  const window = num(raw.window_ms);
  return {
    sample_rate: sample !== null ? Math.max(0, Math.min(1, sample)) : d.sample_rate,
    max_replays_per_tick:
      replays !== null
        ? Math.max(0, Math.min(MAX_REPLAYS_CEILING, Math.floor(replays)))
        : d.max_replays_per_tick,
    window_ms: window !== null && window > 0 ? Math.min(MAX_WINDOW_MS, window) : d.window_ms,
  };
}

export interface ContinuousEvalResult {
  /** Canaries with at least one sampled input this tick. */
  canaries: number;
  sampled: number;
  replayed: number;
  passed: number;
  failed: number;
}

/**
 * Generic quality rubric. With no golden answer for arbitrary production
 * inputs, the judge scores intrinsic answer quality; the regression signal
 * is the canary's pass rate vs. its stable baseline, surfaced in `/audit`.
 */
const QUALITY_RUBRIC: Rubric = {
  criteria:
    'The response is a helpful, correct, and complete answer to the user input, ' +
    'free of errors and without unjustified refusals to a reasonable request.',
  must_include: [],
  must_not_include: [],
  pass_threshold: 0.7,
  trajectory: { max_tool_calls: null, forbidden_tools: [], required_tool_sequence: [] },
};

/** FNV-1a → unit float in [0,1). Stable per-input sampling without a seed. */
function hashUnit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

interface SampledRow {
  user_input: string;
  last_ts: number;
}

/**
 * Distinct production inputs for one manifest within the window, after
 * the deterministic sample gate. Recent-first; deduped so a multi-tool
 * turn (every tool_call carries the same `user_input`) counts once.
 */
async function sampleInputs(
  env: Env,
  canary: ActiveCanary,
  opts: ContinuousEvalOpts,
  sinceMs: number,
  remaining: number,
): Promise<string[]> {
  if (remaining <= 0) return [];
  const rows = await env.DB.prepare(
    `SELECT json_extract(payload_json, '$.user_input') AS user_input, MAX(ts) AS last_ts
       FROM audit_events
       WHERE tenant_id = ? AND manifest_id = ? AND event_type = 'tool_call'
         AND ts >= ? AND json_extract(payload_json, '$.user_input') IS NOT NULL
         AND json_extract(payload_json, '$.replay') IS NULL
       GROUP BY user_input
       ORDER BY last_ts DESC`,
  )
    .bind(canary.tenant_id, canary.name, sinceMs)
    .all<SampledRow>();
  const out: string[] = [];
  for (const row of rows.results ?? []) {
    const input = row.user_input;
    if (!input) continue;
    if (hashUnit(input) >= opts.sample_rate) continue;
    out.push(input);
    if (out.length >= remaining) break;
  }
  return out;
}

/**
 * Replay one input through a pre-built candidate agent, judge it. Fresh
 * context per replay, scoped to the canary's own tenant so the sampled
 * production text never lands in another tenant's audit log, and flagged
 * `replay: true` so the incidental tool_call rows are excluded from future
 * sampling (see `sampleInputs`).
 */
async function replayAndJudge(
  env: Env,
  execCtx: ExecutionContext | undefined,
  tenantId: string,
  agent: Awaited<ReturnType<typeof buildAgent>>,
  judge: Judge,
  input: string,
): Promise<{ score: number; verdict: 'pass' | 'fail'; reasoning: string }> {
  const base = buildAnonymousContext(env, execCtx);
  const ctx: RequestContext = {
    ...base,
    auth: {
      ...base.auth,
      principal: { ...base.auth.principal, tenantId },
    },
    replay: true,
  };
  try {
    return await runWithContext(ctx, async () => {
      const result = await agent.invoke({ messages: [{ role: 'user', content: input }] });
      const response = result.final.content ?? '';
      return judge.evaluate({ userInput: input, response, rubric: QUALITY_RUBRIC });
    });
  } finally {
    disposeLimitState(ctx.limitState);
  }
}

/**
 * Run one tick of continuous eval. Called from `scheduled()` once per
 * cron interval. Returns counts so the caller can record metrics.
 */
export async function runContinuousEvalTick(
  env: Env,
  tools: ToolProvider,
  opts: ContinuousEvalOpts = DEFAULT_CONTINUOUS_EVAL_OPTS,
  now: number = Date.now(),
  execCtx?: ExecutionContext,
): Promise<ContinuousEvalResult> {
  const result: ContinuousEvalResult = {
    canaries: 0,
    sampled: 0,
    replayed: 0,
    passed: 0,
    failed: 0,
  };
  if (!env.DB) return result;

  const sinceMs = now - opts.window_ms;
  const canaries = await listActiveCanaries(env);
  const judge = workersAiJudge(env);

  for (const canary of canaries) {
    const remaining = opts.max_replays_per_tick - result.replayed;
    if (remaining <= 0) break;

    const inputs = await sampleInputs(env, canary, opts, sinceMs, remaining);
    if (inputs.length === 0) continue;
    result.canaries += 1;
    result.sampled += inputs.length;

    // Build the candidate from the canary version directly. A missing
    // version (deleted between the active-pointer read and now) skips
    // the canary rather than failing the whole tick.
    const versioned = await getVersion(env, canary.tenant_id, canary.name, canary.canary_version);
    if (!versioned) continue;

    let agent: Awaited<ReturnType<typeof buildAgent>>;
    try {
      agent = await buildAgent(versioned.manifest, { env, tools });
    } catch (err) {
      console.error(
        `[continuous-eval] build failed for ${canary.name}@${canary.canary_version}:`,
        err,
      );
      continue;
    }

    for (const input of inputs) {
      let verdict: { score: number; verdict: 'pass' | 'fail'; reasoning: string };
      try {
        verdict = await replayAndJudge(env, execCtx, canary.tenant_id, agent, judge, input);
      } catch (err) {
        verdict = {
          score: 0,
          verdict: 'fail',
          reasoning: `replay error: ${(err as Error).message ?? String(err)}`,
        };
      }
      result.replayed += 1;
      if (verdict.verdict === 'pass') result.passed += 1;
      else result.failed += 1;

      recordEventDetached(
        env,
        {
          tenantId: canary.tenant_id,
          eventType: 'judge_score',
          manifestId: canary.name,
          status: verdict.verdict,
          payload: {
            source: 'continuous',
            candidate_version: canary.canary_version,
            stable_version: canary.version,
            score: verdict.score,
            reasoning: verdict.reasoning.slice(0, 500),
            user_input_preview: input.slice(0, 200),
          },
        },
        execCtx,
      );
      recordCounter('orchestrator_continuous_eval', {
        manifest_id: canary.name,
        verdict: verdict.verdict,
      });
    }
  }

  console.log(
    `[continuous-eval] tick — canaries=${result.canaries} sampled=${result.sampled} ` +
      `replayed=${result.replayed} passed=${result.passed} failed=${result.failed}`,
  );
  return result;
}
