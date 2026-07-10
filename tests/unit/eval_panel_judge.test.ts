/**
 * `panelJudge`multi-judge aggregator.
 *
 * Pins:
 *   1. Median aggregator returns the middle score (odd N) or the
 *      mean of the two middle scores (even N).
 *   2. Mean aggregator returns the arithmetic mean.
 *   3. Min aggregator is the strictest — any judge fails → fail.
 *   4. Verdict comes from comparing the aggregated score to the rubric's
 *      `pass_threshold`.
 *   5. The reasoning field concatenates every judge's reasoning so an
 *      operator can trace which judge moved the score.
 *   6. Empty judge list throws at construction (fail loud rather than
 *      silently auto-pass).
 */

import { describe, expect, it } from 'vitest';
import type { JudgeInput } from '../../src/eval/judge';
import { type Judge, panelJudge } from '../../src/eval/judge';

function fixedJudge(score: number, label: string): Judge {
  return {
    async evaluate(_input: JudgeInput) {
      return {
        score,
        verdict: score >= 0.7 ? ('pass' as const) : ('fail' as const),
        reasoning: label,
      };
    },
  };
}

const INPUT: JudgeInput = {
  userInput: 'q',
  response: 'r',
  rubric: {
    criteria: '',
    must_include: [],
    must_not_include: [],
    pass_threshold: 0.7,
    trajectory: { max_tool_calls: null, forbidden_tools: [], required_tool_sequence: [] },
  },
};

describe('panelJudge', () => {
  it('aggregates by median over odd N', async () => {
    const panel = panelJudge([fixedJudge(0.3, 'a'), fixedJudge(0.8, 'b'), fixedJudge(0.9, 'c')]);
    const verdict = await panel.evaluate(INPUT);
    // sorted: [0.3, 0.8, 0.9] → median 0.8
    expect(verdict.score).toBeCloseTo(0.8);
    expect(verdict.verdict).toBe('pass');
  });

  it('aggregates by median over even N (average of the two middle scores)', async () => {
    const panel = panelJudge([
      fixedJudge(0.4, 'a'),
      fixedJudge(0.6, 'b'),
      fixedJudge(0.8, 'c'),
      fixedJudge(1.0, 'd'),
    ]);
    const verdict = await panel.evaluate(INPUT);
    // sorted: [0.4, 0.6, 0.8, 1.0] → median (0.6+0.8)/2 = 0.7
    expect(verdict.score).toBeCloseTo(0.7);
  });

  it('aggregates by mean when requested', async () => {
    const panel = panelJudge([fixedJudge(0.3, 'a'), fixedJudge(0.6, 'b'), fixedJudge(0.9, 'c')], {
      aggregator: 'mean',
    });
    const verdict = await panel.evaluate(INPUT);
    expect(verdict.score).toBeCloseTo(0.6);
  });

  it('aggregates by min when requested (strict — any low score drags the panel down)', async () => {
    const panel = panelJudge(
      [fixedJudge(0.4, 'low'), fixedJudge(0.9, 'high'), fixedJudge(0.95, 'higher')],
      { aggregator: 'min' },
    );
    const verdict = await panel.evaluate(INPUT);
    expect(verdict.score).toBeCloseTo(0.4);
    expect(verdict.verdict).toBe('fail');
  });

  it("concatenates each judge's reasoning so a regression is traceable", async () => {
    const panel = panelJudge([fixedJudge(0.9, 'first OK'), fixedJudge(0.85, 'second OK')]);
    const verdict = await panel.evaluate(INPUT);
    expect(verdict.reasoning).toContain('first OK');
    expect(verdict.reasoning).toContain('second OK');
    expect(verdict.reasoning).toContain('j0');
    expect(verdict.reasoning).toContain('j1');
  });

  it('throws on empty judge list (fail loud)', () => {
    expect(() => panelJudge([])).toThrow(/at least one judge/);
  });
});
