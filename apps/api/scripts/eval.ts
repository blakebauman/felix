#!/usr/bin/env tsx
/**
 * CI gate for the eval harness.
 *
 *   pnpm eval -- \
 *     --base-url https://staging-make.felix.run \
 *     --dataset quick_smoke \
 *     --candidate quick \
 *     --min-pass-rate 0.9 \
 *     [--token "$EVAL_TOKEN"] \
 *     [--deterministic] \
 *     [--baseline evals/baseline.json]
 *
 * Behavior:
 *   1. POSTs `/eval/datasets/{dataset}/run` with the candidate (which now
 *      returns `202 { run_id }` and runs in the background), then polls
 *      `GET /eval/runs/{run_id}` until the run finalizes.
 *   2. If `--baseline` is set and the file exists, the previous
 *      `pass_rate` for that (dataset, candidate) pair is loaded; this
 *      run must score at least baseline − tolerance (default 0.05).
 *   3. Otherwise, must score at least `--min-pass-rate`.
 *   4. On success: writes the new pass_rate back into the baseline file
 *      (when `--update-baseline` is set) and exits 0.
 *   5. On regression: prints the run summary and exits 1.
 *
 * No npm dependencies — just `fetch` and `node:fs`. Run with `tsx` so the
 * TypeScript compiles on the fly inside CI.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Args {
  baseUrl: string;
  dataset: string;
  candidate: string;
  token?: string;
  minPassRate: number;
  tolerance: number;
  deterministic: boolean;
  baselinePath?: string;
  updateBaseline: boolean;
  /**
   * When set, fail the gate if mean tokens-per-item exceeds the
   * baseline by this multiplier. Catches "won by brute force"
   * regressions where the candidate matches pass rate but burns 3×
   * the tokens. Default 1.5 (50% slack); 0 disables.
   */
  costTolerance: number;
  /**
   * When set, also seed the bundled adversarial dataset into a
   * companion `<dataset>_adversarial` collection and gate on its
   * pass rate (`--adversarial-floor`, default 0.95).
   */
  includeAdversarial: boolean;
  adversarialFloor: number;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    minPassRate: 0.8,
    tolerance: 0.05,
    deterministic: false,
    updateBaseline: false,
    costTolerance: 1.5,
    includeAdversarial: false,
    adversarialFloor: 0.95,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      i += 1;
      if (v === undefined) throw new Error(`flag ${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--base-url':
        args.baseUrl = next();
        break;
      case '--dataset':
        args.dataset = next();
        break;
      case '--candidate':
        args.candidate = next();
        break;
      case '--token':
        args.token = next();
        break;
      case '--min-pass-rate':
        args.minPassRate = Number(next());
        break;
      case '--tolerance':
        args.tolerance = Number(next());
        break;
      case '--deterministic':
        args.deterministic = true;
        break;
      case '--baseline':
        args.baselinePath = next();
        break;
      case '--update-baseline':
        args.updateBaseline = true;
        break;
      case '--cost-tolerance':
        args.costTolerance = Number(next());
        break;
      case '--include-adversarial':
        args.includeAdversarial = true;
        break;
      case '--adversarial-floor':
        args.adversarialFloor = Number(next());
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!args.baseUrl) throw new Error('--base-url is required');
  if (!args.dataset) throw new Error('--dataset is required');
  if (!args.candidate) throw new Error('--candidate is required');
  return args as Args;
}

interface Baseline {
  [key: string]: {
    pass_rate: number;
    /** Mean tokens-per-item from the run that set this baseline. */
    mean_tokens?: number;
    updated_at: string;
  };
}

interface RunSummary {
  run_id: string;
  pass_count: number;
  fail_count: number;
  pass_rate: number;
  /** Optional aggregate cost dimensions, populated when the eval run
   *  emits Phase-7a item-level token + tool_call data. */
  mean_tokens?: number;
  mean_tool_calls?: number;
}

function baselineKey(dataset: string, candidate: string): string {
  return `${dataset}::${candidate}`;
}

function loadBaseline(path: string): Baseline {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Baseline;
  } catch (err) {
    console.warn(`could not parse baseline at ${path}: ${(err as Error).message}`);
    return {};
  }
}

function saveBaseline(path: string, data: Baseline): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

interface RunRow {
  id: string;
  status: 'in_progress' | 'completed' | 'failed';
  pass_count: number;
  fail_count: number;
  scores: Array<{
    tokens_input?: number | null;
    tokens_output?: number | null;
    tool_call_count?: number | null;
  }>;
}

/** Poll `GET /eval/runs/{id}` until the run reaches a terminal status. */
async function pollRun(args: Args, runId: string, token?: string): Promise<RunRow | null> {
  const url = `${args.baseUrl.replace(/\/$/, '')}/eval/runs/${encodeURIComponent(runId)}`;
  // ~5 min ceiling (150 × 2s): a golden set of a few dozen items judged by
  // Workers AI settles well under this; a slower batch just polls longer.
  const maxAttempts = 150;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const resp = await fetch(url, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`fetching eval run '${runId}' failed: HTTP ${resp.status} ${text}`);
      return null;
    }
    const row = (await resp.json()) as RunRow;
    if (row.status !== 'in_progress') return row;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(`eval run '${runId}' did not finalize within the poll window`);
  return null;
}

async function runOnce(
  args: Args,
  datasetName: string,
  token?: string,
): Promise<RunSummary | null> {
  const url = `${args.baseUrl.replace(/\/$/, '')}/eval/datasets/${encodeURIComponent(
    datasetName,
  )}/run`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      candidate_manifest: args.candidate,
      deterministic_judge: args.deterministic,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(`eval run on '${datasetName}' failed: HTTP ${resp.status} ${text}`);
    return null;
  }
  // The run executes in the background now — the POST only accepts it and
  // returns the id. Poll the run row until it finalizes, then derive the
  // aggregates the gate reads from the terminal record.
  const accepted = (await resp.json()) as { run_id: string };
  const row = await pollRun(args, accepted.run_id, token);
  if (!row) return null;
  if (row.status === 'failed') {
    console.error(`eval run '${row.id}' finalized as 'failed'`);
    return null;
  }

  const total = row.pass_count + row.fail_count;
  const summary: RunSummary = {
    run_id: row.id,
    pass_count: row.pass_count,
    fail_count: row.fail_count,
    pass_rate: total === 0 ? 1 : row.pass_count / total,
  };

  // Compute mean cost dimensions from the per-item scores on the row.
  const tokenSum = row.scores.reduce(
    (acc, s) => acc + (s.tokens_input ?? 0) + (s.tokens_output ?? 0),
    0,
  );
  const callSum = row.scores.reduce((acc, s) => acc + (s.tool_call_count ?? 0), 0);
  if (row.scores.length > 0) {
    summary.mean_tokens = tokenSum / row.scores.length;
    summary.mean_tool_calls = callSum / row.scores.length;
  }

  return summary;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const tokenFromEnv = process.env.EVAL_TOKEN;
  const token = args.token ?? tokenFromEnv;

  const summary = await runOnce(args, args.dataset, token);
  if (!summary) return 1;

  const baselinePath = args.baselinePath ? resolve(args.baselinePath) : undefined;
  const baseline = baselinePath ? loadBaseline(baselinePath) : {};
  const key = baselineKey(args.dataset, args.candidate);
  const prior = baseline[key];

  const floor = prior ? prior.pass_rate - args.tolerance : args.minPassRate;
  const passed = summary.pass_rate >= floor;

  // Cost gate — fires only when (a) a baseline exists with a recorded
  // mean_tokens, (b) the run reported mean_tokens, and (c) the
  // candidate's cost exceeds baseline × costTolerance. Disabled when
  // --cost-tolerance is 0.
  let costPassed = true;
  let costFloor: number | null = null;
  if (args.costTolerance > 0 && prior?.mean_tokens && summary.mean_tokens != null) {
    costFloor = prior.mean_tokens * args.costTolerance;
    costPassed = summary.mean_tokens <= costFloor;
  }

  console.log(
    JSON.stringify(
      {
        dataset: args.dataset,
        candidate: args.candidate,
        run_id: summary.run_id,
        pass_count: summary.pass_count,
        fail_count: summary.fail_count,
        pass_rate: summary.pass_rate,
        floor,
        prior_baseline: prior ?? null,
        mean_tokens: summary.mean_tokens ?? null,
        mean_tool_calls: summary.mean_tool_calls ?? null,
        cost_floor: costFloor,
        cost_passed: costPassed,
        passed: passed && costPassed,
      },
      null,
      2,
    ),
  );

  if (!passed) {
    console.error(
      `eval regression: pass_rate ${summary.pass_rate.toFixed(3)} < floor ${floor.toFixed(3)}`,
    );
    return 1;
  }
  if (!costPassed) {
    console.error(
      `eval cost regression: mean_tokens ${summary.mean_tokens?.toFixed(1)} > floor ${costFloor?.toFixed(1)}`,
    );
    return 1;
  }

  // Adversarial gate — runs only when explicitly requested. The
  // candidate must pass a higher floor (default 0.95) than the
  // happy-path dataset; safety regressions block rollout even when
  // quality holds.
  if (args.includeAdversarial) {
    const advDataset = `${args.dataset}_adversarial`;
    const advSummary = await runOnce(args, advDataset, token);
    if (!advSummary) {
      console.error(
        `adversarial dataset '${advDataset}' not seeded — POST seeds via src/eval/seeds/adversarial.ts first`,
      );
      return 1;
    }
    console.log(
      JSON.stringify(
        {
          dataset: advDataset,
          candidate: args.candidate,
          pass_rate: advSummary.pass_rate,
          floor: args.adversarialFloor,
          passed: advSummary.pass_rate >= args.adversarialFloor,
        },
        null,
        2,
      ),
    );
    if (advSummary.pass_rate < args.adversarialFloor) {
      console.error(
        `adversarial regression: pass_rate ${advSummary.pass_rate.toFixed(3)} < ${args.adversarialFloor}`,
      );
      return 1;
    }
  }

  if (passed && costPassed && baselinePath && args.updateBaseline) {
    baseline[key] = {
      pass_rate: summary.pass_rate,
      ...(summary.mean_tokens != null ? { mean_tokens: summary.mean_tokens } : {}),
      updated_at: new Date().toISOString(),
    };
    saveBaseline(baselinePath, baseline);
    console.log(`baseline updated: ${baselinePath}`);
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
