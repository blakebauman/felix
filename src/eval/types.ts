/**
 * Eval harness types — datasets, items, rubrics, runs.
 *
 * Phase-2 framing (Cursor's "offline benchmarks dominate ship/no-ship"):
 *   - An `EvalDataset` is a named collection of inputs owned by one
 *     tenant. Items are append-only so a golden baseline stays
 *     comparable across runs of (dataset × candidate_manifest).
 *   - Each `EvalDatasetItem` carries a `user_input` and a `Rubric` —
 *     the contract the response is judged against.
 *   - `Rubric.must_include` / `must_not_include` are cheap, deterministic
 *     gates checked in code; `criteria` drives the Workers-AI judge for
 *     nuanced scoring.
 *   - An `EvalRun` captures one execution: per-item `ItemScore` rows
 *     plus aggregate pass/fail counts. The CI gate compares the latest
 *     run against a baseline to fail merges on regressions.
 */

import { z } from '@hono/zod-openapi';

/**
 * Trajectory rubric — pins the *shape* of the tool-call sequence, not
 * just the final answer. Lets evals catch the "right answer via a
 * wasteful path" regression that pure response-level scoring misses.
 *
 *   - `max_tool_calls`: hard cap on tool invocations the agent may make.
 *   - `forbidden_tools`: any call to one of these auto-fails the item.
 *   - `required_tool_sequence`: tool names that must appear in this
 *     order (subsequence — extra tools may interleave). A common
 *     pattern: `['plan_create', 'plan_update_step']` for plan-driven flows.
 */
export const TrajectoryRubricSchema = z
  .object({
    max_tool_calls: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .openapi({ description: 'Hard cap on tool invocations. Null disables.' }),
    forbidden_tools: z
      .array(z.string())
      .default([])
      .openapi({ description: 'Tool names that, if invoked, auto-fail the item.' }),
    required_tool_sequence: z.array(z.string()).default([]).openapi({
      description:
        'Tool names that must appear in this order (subsequence — extra tools may interleave).',
    }),
  })
  .strict()
  .openapi('TrajectoryRubric');

export type TrajectoryRubric = z.infer<typeof TrajectoryRubricSchema>;

export const RubricSchema = z
  .object({
    criteria: z
      .string()
      .default('')
      .openapi({ description: 'Free-form pass criteria the Workers-AI judge evaluates against.' }),
    must_include: z
      .array(z.string())
      .default([])
      .openapi({ description: 'Case-insensitive substrings the response must contain.' }),
    must_not_include: z
      .array(z.string())
      .default([])
      .openapi({ description: 'Case-insensitive substrings the response must NOT contain.' }),
    pass_threshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.7)
      .openapi({ description: 'Judge score floor for a pass. Default 0.7.' }),
    trajectory: TrajectoryRubricSchema.default({
      max_tool_calls: null,
      forbidden_tools: [],
      required_tool_sequence: [],
    }).openapi({
      description: 'Trajectory gates — score the tool-call sequence, not just the final response.',
    }),
  })
  .strict()
  .openapi('Rubric');

export type Rubric = z.infer<typeof RubricSchema>;

export const EvalDatasetSchema = z
  .object({
    name: z.string(),
    description: z.string().default(''),
    created_at: z.number().int(),
  })
  .openapi('EvalDataset');

export type EvalDataset = z.infer<typeof EvalDatasetSchema>;

export const EvalDatasetItemSchema = z
  .object({
    dataset_name: z.string(),
    item_id: z.string(),
    user_input: z.string(),
    rubric: RubricSchema,
    created_at: z.number().int(),
  })
  .openapi('EvalDatasetItem');

export type EvalDatasetItem = z.infer<typeof EvalDatasetItemSchema>;

export const ItemScoreSchema = z
  .object({
    item_id: z.string(),
    score: z.number().min(0).max(1),
    verdict: z.enum(['pass', 'fail']),
    reasoning: z.string(),
    response: z.string(),
    /**
     * Cost dimensions per item. Optional (older rows pre-Phase-7a have
     * none) so the CI gate's cost-tolerance check tolerates missing data
     * by skipping the cost comparison rather than failing.
     */
    tokens_input: z.number().int().nullable().optional(),
    tokens_output: z.number().int().nullable().optional(),
    tool_call_count: z.number().int().nullable().optional(),
    duration_ms: z.number().int().nullable().optional(),
  })
  .openapi('EvalItemScore');

export type ItemScore = z.infer<typeof ItemScoreSchema>;

export const EvalRunSchema = z
  .object({
    id: z.string(),
    dataset_name: z.string(),
    candidate_manifest: z.string(),
    started_at: z.number().int(),
    finished_at: z.number().int().nullable(),
    status: z.enum(['in_progress', 'completed', 'failed']),
    pass_count: z.number().int(),
    fail_count: z.number().int(),
    scores: z.array(ItemScoreSchema),
  })
  .openapi('EvalRun');

export type EvalRun = z.infer<typeof EvalRunSchema>;
