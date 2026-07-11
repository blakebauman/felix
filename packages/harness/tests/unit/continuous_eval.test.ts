/**
 * Continuous-eval unit tests.
 *
 * Pins the online-benchmarking contract: each in-flight canary has its
 * recent production inputs (captured as `user_input` on `tool_call` audit
 * rows) sampled, replayed through the canary version, judged, and surfaced
 * as `judge_score` events tagged `source: 'continuous'`. The store + agent
 * builder + judge are stubbed so the test stays decoupled from D1 / AI.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../src/audit/models';
import type { Env } from '../../src/env';
import * as judgeModule from '../../src/eval/judge';
import { deterministicJudge } from '../../src/eval/judge';
import {
  type ContinuousEvalOpts,
  DEFAULT_CONTINUOUS_EVAL_OPTS,
  parseContinuousEvalOpts,
  runContinuousEvalTick,
} from '../../src/jobs/continuous-eval';
import * as builderModule from '../../src/manifests/builder';
import type { ManifestVersionRow } from '../../src/manifests/store';
import * as storeModule from '../../src/manifests/store';
import type { Agent, ChatMessage, InvokeInput, InvokeResult } from '../../src/patterns/types';
import type { ToolProvider } from '../../src/tools/provider';

const toolsStub = { resolve: () => [] } as unknown as ToolProvider;

function fakeAgent(reply: (input: string) => string): Agent {
  return {
    tools: [],
    pattern: 'react',
    manifestId: 'cand',
    manifestVersion: '2',
    async invoke(input: InvokeInput): Promise<InvokeResult> {
      const userText =
        typeof input.messages.at(-1)?.content === 'string'
          ? (input.messages.at(-1)?.content as string)
          : '';
      const final: ChatMessage = { role: 'assistant', content: reply(userText) };
      return { messages: [final], final };
    },
    async *streamEvents() {},
  };
}

/** Env whose DB returns `inputRows` for the sample query and collects audit sends. */
function fakeEnv(
  inputRows: Array<{ user_input: string; last_ts: number }>,
  sink: AuditEvent[],
): Env {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: inputRows }),
        }),
      }),
    },
    AUDIT_QUEUE: {
      send: (e: AuditEvent) => {
        sink.push(e);
        return Promise.resolve();
      },
    },
  } as unknown as Env;
}

function versionRow(canaryVersion: number): ManifestVersionRow {
  return {
    tenant_id: 'acme',
    name: 'support',
    version: canaryVersion,
    manifest: { metadata: { name: 'support' } } as unknown as ManifestVersionRow['manifest'],
    created_at: 1,
    created_by: 'tester',
    comment: '',
  };
}

const OPTS: ContinuousEvalOpts = {
  sample_rate: 1, // hashUnit() < 1 always → replay every distinct input
  max_replays_per_tick: 10,
  window_ms: 10 * 60 * 1000,
};

describe('continuous eval — canary online benchmarking', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(builderModule, 'buildAgent').mockResolvedValue(
      fakeAgent((input) => `Answer to: ${input}`),
    );
    vi.spyOn(storeModule, 'getVersion').mockResolvedValue(versionRow(2));
    // Deterministic judge: passes (no criteria gates trip on these inputs).
    vi.spyOn(judgeModule, 'workersAiJudge').mockReturnValue(deterministicJudge());
  });

  it('replays each distinct sampled input through the canary and emits judge_score', async () => {
    vi.spyOn(storeModule, 'listActiveCanaries').mockResolvedValue([
      { tenant_id: 'acme', name: 'support', version: 1, canary_version: 2, canary_weight: 25 },
    ]);
    const sink: AuditEvent[] = [];
    const env = fakeEnv(
      [
        { user_input: 'reset my password', last_ts: 200 },
        { user_input: 'cancel my plan', last_ts: 100 },
      ],
      sink,
    );

    const result = await runContinuousEvalTick(env, toolsStub, OPTS, 1_000_000);

    expect(result.canaries).toBe(1);
    expect(result.sampled).toBe(2);
    expect(result.replayed).toBe(2);
    expect(result.passed).toBe(2);

    const scores = sink.filter((e) => e.event_type === 'judge_score');
    expect(scores).toHaveLength(2);
    for (const s of scores) {
      expect(s.tenant_id).toBe('acme');
      expect(s.manifest_id).toBe('support');
      expect(s.payload.source).toBe('continuous');
      expect(s.payload.candidate_version).toBe(2);
      expect(s.payload.stable_version).toBe(1);
    }
  });

  it('is a no-op when no canaries are in flight', async () => {
    vi.spyOn(storeModule, 'listActiveCanaries').mockResolvedValue([]);
    const sink: AuditEvent[] = [];
    const result = await runContinuousEvalTick(fakeEnv([], sink), toolsStub, OPTS, 1_000_000);
    expect(result).toEqual({ canaries: 0, sampled: 0, replayed: 0, passed: 0, failed: 0 });
    expect(sink).toHaveLength(0);
  });

  it('parseContinuousEvalOpts — defaults, overrides, clamps, and bad JSON', () => {
    const env = (v?: string) => ({ CONTINUOUS_EVAL: v }) as unknown as Env;
    // Unset → defaults.
    expect(parseContinuousEvalOpts(env())).toEqual(DEFAULT_CONTINUOUS_EVAL_OPTS);
    // Bad JSON → defaults.
    expect(parseContinuousEvalOpts(env('{not json'))).toEqual(DEFAULT_CONTINUOUS_EVAL_OPTS);
    // Valid override.
    expect(
      parseContinuousEvalOpts(
        env('{"sample_rate":0.05,"max_replays_per_tick":25,"window_ms":300000}'),
      ),
    ).toEqual({ sample_rate: 0.05, max_replays_per_tick: 25, window_ms: 300000 });
    // Out-of-range fields clamp; sample_rate>1 → 1, replays floored & capped at 200.
    expect(parseContinuousEvalOpts(env('{"sample_rate":5,"max_replays_per_tick":9999.7}'))).toEqual(
      {
        sample_rate: 1,
        max_replays_per_tick: 200,
        window_ms: DEFAULT_CONTINUOUS_EVAL_OPTS.window_ms,
      },
    );
    // Partial / wrong-typed fields fall back per-field.
    expect(parseContinuousEvalOpts(env('{"sample_rate":"nope"}'))).toEqual(
      DEFAULT_CONTINUOUS_EVAL_OPTS,
    );
  });

  it('honors max_replays_per_tick as a hard cap', async () => {
    vi.spyOn(storeModule, 'listActiveCanaries').mockResolvedValue([
      { tenant_id: 'acme', name: 'support', version: 1, canary_version: 2, canary_weight: 25 },
    ]);
    const sink: AuditEvent[] = [];
    const env = fakeEnv(
      Array.from({ length: 5 }, (_, i) => ({ user_input: `q${i}`, last_ts: i })),
      sink,
    );
    const result = await runContinuousEvalTick(
      env,
      toolsStub,
      { ...OPTS, max_replays_per_tick: 3 },
      1_000_000,
    );
    expect(result.replayed).toBe(3);
    expect(sink.filter((e) => e.event_type === 'judge_score')).toHaveLength(3);
  });
});
