import { z } from '@hono/zod-openapi';

export const JudgeRuleSchema = z
  .object({
    name: z.string().min(1).openapi({
      description: 'Stable identifier for the judge — surfaced in audit and metrics.',
      example: 'relevance',
    }),
    criteria: z
      .string()
      .min(1)
      .openapi({
        description:
          'Free-form pass criteria the Workers-AI judge model evaluates against. Phrased so a ' +
          'score of 1.0 means "fully satisfies the criteria" and 0.0 means "fully fails it".',
        example: 'response should be on-topic and directly answer the tool input',
      }),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.7)
      .openapi({
        description:
          'Score floor for a pass. Below this, the wrapper denies the tool result with a ' +
          '`[judge denied] …` message. Above, the call proceeds unchanged.',
      }),
    model: z
      .string()
      .default('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
      .openapi({
        description:
          'Workers-AI model id the judge uses. Native `env.AI` binding — no AI Gateway tokens, ' +
          'same isolate. Choose a smaller model (e.g. `@cf/google/gemma-3-12b-it`) for cheaper ' +
          'judging.',
      }),
    target_tools: z
      .array(z.string())
      .default([])
      .openapi({
        description:
          'When empty, the judge scores every tool result. When non-empty, only tools whose ' +
          '`name` is in this list are scored — useful for narrow judges that only apply to a ' +
          'few high-stakes tools. Ignored when `final_response` is true.',
      }),
    final_response: z
      .boolean()
      .default(false)
      .openapi({
        description:
          "When true, this judge scores the model's FINAL user-facing answer instead of tool " +
          'results (and `guardrails.targets` must include `final_response`). A below-threshold ' +
          'score replaces the answer with a notice. Because a judge needs the complete answer, ' +
          'it can only BLOCK on the non-streaming path and streaming `buffer` mode; under ' +
          'streaming `passthrough` the bytes have already been sent, so the judge scores the ' +
          'persisted message but cannot retract streamed output.',
      }),
  })
  .strict()
  .openapi('JudgeRule');

export type JudgeRule = z.infer<typeof JudgeRuleSchema>;

export const GuardrailsSchema = z
  .object({
    providers: z
      .array(z.string())
      .default([])
      .refine((ps) => !ps.includes('bedrock'), {
        // `bedrock` is wired into the FILTERS registry but its filter is a
        // no-op today (src/guardrails/pipeline.ts). Accepting it would give a
        // manifest *silent zero filtering* while appearing protected — a
        // fail-open control. Reject it at validation time until the AI Gateway
        // content-policy bridge is actually implemented.
        message:
          "guardrail provider 'bedrock' is not yet implemented (no-op filter); remove it until the AI Gateway content-policy hook is wired",
      })
      .openapi({
        description:
          'Active guardrail providers. `pii` runs four regex patterns (email, SSN, US ' +
          'phone, credit card) with SHA-256 fingerprints written to audit (never the raw ' +
          'value). `bedrock` is reserved for a future AI Gateway content policy hook and is ' +
          'currently rejected at validation time.',
        example: ['pii'],
      }),
    block_on_match: z.boolean().default(false).openapi({
      description: 'When true, a match denies the request. When false, the match is redacted.',
    }),
    targets: z
      .array(z.enum(['input', 'output', 'final_response']))
      .default(['input', 'output'])
      .openapi({
        description:
          'Which sides of the conversation are scanned. `input` / `output` scan tool arguments ' +
          "and tool results (the default). `final_response` additionally scans the model's " +
          'user-facing answer at the end of the loop — see `final_response` below. Off by default ' +
          'so enabling it is an explicit choice.',
      }),
    final_response: z
      .object({
        on_match: z
          .enum(['redact', 'block'])
          .default('redact')
          .openapi({
            description:
              'How a match in the final answer is handled. `redact` replaces the matched spans ' +
              '(like the tool-output filter). `block` replaces the entire answer with a fixed ' +
              'notice. `redact` is the default — the regex filters false-positive (a long order ' +
              'number can trip the credit-card pattern), and that risk lands on the user-facing path.',
          }),
        streaming: z
          .enum(['buffer', 'passthrough'])
          .default('buffer')
          .openapi({
            description:
              'How streamed responses are guarded. `buffer` accumulates the streamed deltas, ' +
              'filters once the answer is complete, then emits the guarded text (correct, but ' +
              'trades token-by-token time-to-first-token). `passthrough` streams deltas raw — the ' +
              'streamed bytes are NOT filtered, only the message persisted to the session is — and ' +
              'emits `orchestrator_final_guard_skipped` so operators know. `buffer` is the ' +
              'safe-by-default choice; opt into `passthrough` knowingly.',
          }),
      })
      .strict()
      .default({ on_match: 'redact', streaming: 'buffer' })
      .openapi({
        description:
          "Behavior for scanning the model's final user-facing answer. Only consulted when " +
          '`targets` includes `final_response`. Reuses `providers` as the filter set; runs ' +
          'OUTSIDE the tool-executor wrapper chain (it operates on the assistant message content).',
      }),
    judges: z
      .array(JudgeRuleSchema)
      .default([])
      .openapi({
        description:
          'Inferential sensors (Fowler) that score tool results against a free-form criteria ' +
          'string using Workers-AI. Composed *after* the regex-style content guardrails: a ' +
          'tool result that escapes a `pii` filter can still be denied by a judge for being ' +
          'off-topic or risky. Each rule emits a `judge_score` audit event per call so a ' +
          'regression in a specific judge surfaces in `/audit/metrics`. Skipped on outputs ' +
          'already flagged by `denyOutput` / `toolErrorOutput` — judging a deny string is ' +
          'wasted compute and double-emits the failure signal.',
      }),
  })
  .strict()
  .openapi('Guardrails');

export type Guardrails = z.infer<typeof GuardrailsSchema>;

export const DEFAULT_GUARDRAILS: Guardrails = {
  providers: [],
  block_on_match: false,
  targets: ['input', 'output'],
  final_response: { on_match: 'redact', streaming: 'buffer' },
  judges: [],
};

export function guardrailsEnabled(g: Guardrails): boolean {
  return g.providers.length > 0;
}

export function judgesEnabled(g: Guardrails): boolean {
  return g.judges.length > 0;
}

/** Judges that score the final answer (not tool results). */
export function finalResponseJudges(g: Guardrails): JudgeRule[] {
  return g.judges.filter((j) => j.final_response);
}

/**
 * True when the final-response guard should run: the caller opted `final_response`
 * into `targets` AND there's something to run over the answer — a content-filter
 * provider or a judge flagged `final_response`.
 */
export function finalResponseGuardEnabled(g: Guardrails): boolean {
  if (!g.targets.includes('final_response')) return false;
  return g.providers.length > 0 || finalResponseJudges(g).length > 0;
}
