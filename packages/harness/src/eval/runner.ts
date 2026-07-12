/**
 * Eval runner — drive a candidate manifest through a dataset's items,
 * judge each response, persist the resulting `EvalRun`.
 *
 * Execution is off the request path. `runDataset` iterates the dataset
 * items serially (no parallelism — keeps audit ordering and token spend
 * predictable), but the `/eval` run route does NOT await it: it creates
 * the `in_progress` run row, hands `runDatasetDetached` to
 * `execCtx.waitUntil`, and returns `202 { run_id }` immediately. This
 * keeps large datasets from blowing the Worker CPU / subrequest ceiling
 * that a synchronous-in-request run hit. `GET /eval/runs/:id` reflects
 * live status; the row finalizes to `completed` / `failed` when the
 * background job settles, which is exactly what the `/manifests`
 * activation gate reads.
 *
 * A dedicated Cloudflare Workflow (`EvalRunWorkflow`, bound as
 * `EVAL_WORKFLOW`) is the ideal home for very large / long-running
 * batches — it would survive a Worker eviction mid-run and replay from
 * the last completed step, the same way `AgentWorkflow` backs durable
 * agent invokes. `waitUntil` is used here instead because it needs no
 * new binding to verify end-to-end; the Workflow variant is a drop-in
 * upgrade to `runDatasetDetached` once the binding is wired.
 *
 * Each scored item emits a `judge_score` audit event so an operator can
 * trace a regression back to the exact input, response, and rubric.
 */

import { recordEvent } from '../audit/store';
import { buildAnonymousContext, disposeLimitState, getContext, runWithContext } from '../context';
import type { Env } from '../env';
import { buildAgent } from '../manifests/builder';
import { resolveManifest } from '../manifests/resolver';
import type { Agent } from '../patterns/types';
import type { ToolProvider } from '../tools/provider';
import { finalizeRun, listItems } from './datasets';
import type { Judge } from './judge';
import { scoreTrajectory } from './trajectory';
import type { EvalDatasetItem, ItemScore } from './types';

export interface RunOptions {
  tenantId: string;
  principalSubject: string;
  runId: string;
  datasetName: string;
  candidateManifest: string;
  /**
   * Pin the candidate to a specific tenant-managed version instead of the
   * active pointer. Lets an operator eval an inactive version *before*
   * activating it — the run records this version so the `/manifests`
   * activation gate can match it. Omit to test whatever is currently active.
   */
  candidateVersion?: number;
  judge: Judge;
}

export interface RunResult {
  runId: string;
  scores: ItemScore[];
  passCount: number;
  failCount: number;
  passRate: number;
}

async function judgeOne(agent: Agent, item: EvalDatasetItem, judge: Judge): Promise<ItemScore> {
  // Snapshot token usage so we can report per-item cost. The
  // RequestContext is installed by the /eval route's auth middleware;
  // when absent (direct unit-test invocation), we fall back to zero
  // deltas — the cost dimension is optional in `ItemScore`.
  const ctx = getContext();
  const beforeInput = ctx?.limitState.tokens.input ?? 0;
  const beforeOutput = ctx?.limitState.tokens.output ?? 0;
  const startedAt = Date.now();

  const invokeResult = await agent.invoke({
    messages: [{ role: 'user', content: item.user_input }],
  });
  const response = invokeResult.final.content ?? '';

  const afterInput = ctx?.limitState.tokens.input ?? 0;
  const afterOutput = ctx?.limitState.tokens.output ?? 0;
  const duration_ms = Date.now() - startedAt;

  // Trajectory gate runs *before* the judge — it's deterministic and
  // free, and catches the most common regression class (right answer
  // via wasteful path). A failure here short-circuits the judge call.
  const traj = scoreTrajectory(invokeResult.messages, item.rubric.trajectory);
  if (!traj.passed) {
    return {
      item_id: item.item_id,
      score: 0,
      verdict: 'fail',
      reasoning: traj.reason ?? 'trajectory gate failed',
      response,
      tokens_input: afterInput - beforeInput,
      tokens_output: afterOutput - beforeOutput,
      tool_call_count: traj.tool_call_count,
      duration_ms,
    };
  }

  const verdict = await judge.evaluate({
    userInput: item.user_input,
    response,
    rubric: item.rubric,
  });
  return {
    item_id: item.item_id,
    score: verdict.score,
    verdict: verdict.verdict,
    reasoning: verdict.reasoning,
    response,
    tokens_input: afterInput - beforeInput,
    tokens_output: afterOutput - beforeOutput,
    tool_call_count: traj.tool_call_count,
    duration_ms,
  };
}

export async function runDataset(
  env: Env,
  tools: ToolProvider,
  opts: RunOptions,
): Promise<RunResult> {
  // Any failure between here and the completion finalize (manifest not
  // found, buildAgent throw, dataset read error) MUST still transition the
  // run row out of `in_progress` — otherwise a timed-out or crashed run is
  // stuck pending forever and the CI / activation gate can never read a
  // terminal status. The catch finalizes `failed` before re-raising.
  try {
    const resolved = await resolveManifest(
      env,
      opts.tenantId,
      opts.candidateManifest,
      opts.candidateVersion != null ? { pinVersion: opts.candidateVersion } : {},
    );
    const agent = await buildAgent(resolved.manifest, { env, tools });
    const items = await listItems(env, opts.tenantId, opts.datasetName);

    const scores: ItemScore[] = [];
    for (const item of items) {
      let score: ItemScore;
      try {
        score = await judgeOne(agent, item, opts.judge);
      } catch (err) {
        // A thrown error during invoke or judge keeps the run alive — we
        // mark the item failed and continue. Audit captures the cause.
        score = {
          item_id: item.item_id,
          score: 0,
          verdict: 'fail',
          reasoning: `runner error: ${(err as Error).message ?? String(err)}`,
          response: '',
        };
      }
      scores.push(score);
      recordEvent({
        tenantId: opts.tenantId,
        eventType: 'judge_score',
        principalSubject: opts.principalSubject,
        manifestId: opts.candidateManifest,
        status: score.verdict,
        payload: {
          run_id: opts.runId,
          dataset: opts.datasetName,
          item_id: item.item_id,
          score: score.score,
          reasoning: score.reasoning.slice(0, 500),
        },
      });
    }

    await finalizeRun(env, opts.tenantId, opts.runId, {
      status: 'completed',
      scores,
      // Only tenant-D1 resolutions carry a version; bundled / R2 leave it
      // null so those runs can never satisfy the version-scoped gate.
      manifestVersion: resolved.version ?? null,
    });
    const passes = scores.filter((s) => s.verdict === 'pass').length;
    const fails = scores.length - passes;
    const passRate = scores.length === 0 ? 1 : passes / scores.length;
    return { runId: opts.runId, scores, passCount: passes, failCount: fails, passRate };
  } catch (err) {
    await finalizeRun(env, opts.tenantId, opts.runId, {
      status: 'failed',
      scores: [],
      manifestVersion: opts.candidateVersion ?? null,
    });
    throw err;
  }
}

/**
 * Run a dataset in a detached background context — the body handed to
 * `execCtx.waitUntil` by the `/eval` run route.
 *
 * The request's AsyncLocalStorage scope (installed by `authMiddleware`)
 * has already unwound and its `LimitState` been disposed by the time
 * `waitUntil` fires, so this installs a FRESH anonymous `RequestContext`
 * scoped to the run's tenant + principal. Without it, `recordEvent`
 * falls back to `console.log` instead of enqueueing `judge_score` rows,
 * and `buildAgent` / `agent.invoke` would run without a `LimitState`.
 *
 * Never throws: `runDataset` already finalizes the run row to `failed`
 * on any error before re-raising, so a background failure still leaves a
 * terminal row for the activation gate to read. This wrapper additionally
 * swallows so a rejected `waitUntil` promise can't surface as an
 * unhandled rejection, and disposes the fresh `LimitState` in `finally`.
 */
export async function runDatasetDetached(
  env: Env,
  tools: ToolProvider,
  opts: RunOptions,
  execCtx?: ExecutionContext,
): Promise<void> {
  const reqCtx = buildAnonymousContext(env, execCtx);
  reqCtx.auth = {
    ...reqCtx.auth,
    principal: {
      ...reqCtx.auth.principal,
      tenantId: opts.tenantId,
      subject: opts.principalSubject,
    },
  };
  try {
    await runWithContext(reqCtx, () => runDataset(env, tools, opts));
  } catch (err) {
    // runDataset already finalized the row `failed`; log so the failure
    // is observable but don't reject the waitUntil promise.
    console.error(`detached eval run ${opts.runId} failed`, err);
  } finally {
    disposeLimitState(reqCtx.limitState);
  }
}
