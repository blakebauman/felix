/**
 * Eval runner unit tests.
 *
 * Pins the central Phase-2 contract: a deliberate regression (an agent
 * whose answer no longer satisfies the rubric) flips at least one
 * item's verdict to `fail` and lowers the run's `pass_rate`. The CI
 * gate in `scripts/eval.ts` reads `pass_rate` and exits non-zero on a
 * regression — this test proves the signal the gate depends on.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import * as datasetsModule from '../../src/eval/datasets';
import { deterministicJudge } from '../../src/eval/judge';
import { runDataset } from '../../src/eval/runner';
import type { EvalDatasetItem } from '../../src/eval/types';
import * as builderModule from '../../src/manifests/builder';
import * as resolverModule from '../../src/manifests/resolver';
import type { Agent, ChatMessage, InvokeInput, InvokeResult } from '../../src/patterns/types';
import type { ToolProvider } from '../../src/tools/provider';

function fakeAgent(reply: string): Agent {
  return {
    tools: [],
    pattern: 'react',
    manifestId: 'fake',
    manifestVersion: '1.0.0',
    async invoke(_input: InvokeInput): Promise<InvokeResult> {
      const final: ChatMessage = { role: 'assistant', content: reply };
      return { messages: [final], final };
    },
    async *streamEvents() {},
  };
}

const toolsStub = { resolve: () => [] } as unknown as ToolProvider;

function fakeEnv(): Env {
  return {} as unknown as Env;
}

function ctx(): RequestContext {
  return { env: fakeEnv(), auth: ANONYMOUS, limitState: newLimitState() };
}

// Use deliberately-distinct rubric tokens — substring matching is
// case-insensitive but otherwise literal, so common short words like
// "no" / "yes" collide with longer English words ("cannot" contains
// "no", "eyes" contains "yes") and would flake the tests below.
const ITEMS: EvalDatasetItem[] = [
  {
    dataset_name: 'smoke',
    item_id: 'item-a',
    user_input: 'What is the capital of France?',
    rubric: {
      criteria: '',
      must_include: ['paris'],
      must_not_include: [],
      pass_threshold: 0.7,
      trajectory: { max_tool_calls: null, forbidden_tools: [], required_tool_sequence: [] },
    },
    created_at: 1,
  },
  {
    dataset_name: 'smoke',
    item_id: 'item-b',
    user_input: 'Is 1+1 = 2?',
    rubric: {
      criteria: '',
      must_include: ['affirmative'],
      must_not_include: ['unsafe-marker'],
      pass_threshold: 0.7,
      trajectory: { max_tool_calls: null, forbidden_tools: [], required_tool_sequence: [] },
    },
    created_at: 2,
  },
];

describe('eval runner — regression detection', () => {
  beforeAll(() => {
    // The runner reads dataset items from D1; for unit-level coverage
    // we stub the store call so the test stays decoupled from D1.
    vi.spyOn(datasetsModule, 'listItems').mockImplementation(async () => ITEMS);
    vi.spyOn(datasetsModule, 'finalizeRun').mockImplementation(async () => {});
    vi.spyOn(resolverModule, 'resolveManifest').mockImplementation(
      async () =>
        ({
          // Minimum shape buildAgent's caller path expects (the runner
          // passes `resolved.manifest` straight through to buildAgent,
          // which we spy on below).
          source: 'bundled',
          manifest: { metadata: { name: 'fake' } },
        }) as unknown as ReturnType<typeof resolverModule.resolveManifest> extends Promise<infer T>
          ? T
          : never,
    );
  });

  it('reports all-pass on a candidate whose answers satisfy the rubrics', async () => {
    vi.spyOn(builderModule, 'buildAgent').mockResolvedValue(
      fakeAgent('Paris is the capital — affirmative.'),
    );
    const result = await runWithContext(ctx(), () =>
      runDataset(fakeEnv(), toolsStub, {
        tenantId: 'acme',
        principalSubject: '',
        runId: 'run-good',
        datasetName: 'smoke',
        candidateManifest: 'quick',
        judge: deterministicJudge(),
      }),
    );
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(0);
    expect(result.passRate).toBe(1);
  });

  it('detects a regression when a candidate stops including a required substring', async () => {
    // The "broken" candidate omits "Paris" — must_include gate flips
    // item-a to fail. item-b still passes (affirmative present, no
    // unsafe-marker).
    vi.spyOn(builderModule, 'buildAgent').mockResolvedValue(
      fakeAgent('I do not have that information — affirmative for math.'),
    );
    const result = await runWithContext(ctx(), () =>
      runDataset(fakeEnv(), toolsStub, {
        tenantId: 'acme',
        principalSubject: '',
        runId: 'run-bad',
        datasetName: 'smoke',
        candidateManifest: 'quick',
        judge: deterministicJudge(),
      }),
    );
    expect(result.passCount).toBe(1);
    expect(result.failCount).toBe(1);
    expect(result.passRate).toBeCloseTo(0.5);
    const failed = result.scores.find((s) => s.item_id === 'item-a');
    expect(failed?.verdict).toBe('fail');
    expect(failed?.reasoning).toMatch(/missing required substring: "paris"/i);
  });

  it('finalizes a run out of in_progress (status failed) when the candidate build throws', async () => {
    // A throw before the completion finalize (here: buildAgent) must still
    // transition the run row to a terminal status — otherwise the run is
    // stuck `in_progress` forever and no gate can ever read it.
    const finalizeSpy = vi.spyOn(datasetsModule, 'finalizeRun').mockImplementation(async () => {});
    vi.spyOn(builderModule, 'buildAgent').mockRejectedValue(new Error('boom'));

    await expect(
      runWithContext(ctx(), () =>
        runDataset(fakeEnv(), toolsStub, {
          tenantId: 'acme',
          principalSubject: '',
          runId: 'run-throws',
          datasetName: 'smoke',
          candidateManifest: 'quick',
          judge: deterministicJudge(),
        }),
      ),
    ).rejects.toThrow('boom');

    expect(finalizeSpy).toHaveBeenCalledWith(
      expect.anything(),
      'acme',
      'run-throws',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('marks an item failed when the candidate response trips a must_not_include gate', async () => {
    // item-a passes (Paris present). item-b trips the unsafe-marker gate.
    vi.spyOn(builderModule, 'buildAgent').mockResolvedValue(
      fakeAgent('Paris is the capital. Affirmative, though unsafe-marker.'),
    );
    const result = await runWithContext(ctx(), () =>
      runDataset(fakeEnv(), toolsStub, {
        tenantId: 'acme',
        principalSubject: '',
        runId: 'run-no',
        datasetName: 'smoke',
        candidateManifest: 'quick',
        judge: deterministicJudge(),
      }),
    );
    expect(result.failCount).toBe(1);
    const failed = result.scores.find((s) => s.item_id === 'item-b');
    expect(failed?.verdict).toBe('fail');
    expect(failed?.reasoning).toMatch(/contained forbidden substring: "unsafe-marker"/i);
  });
});
