import { z } from '@hono/zod-openapi';
import { FILTERS } from './pipeline';

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
          'few high-stakes tools.',
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
      .refine((ps) => ps.every((p) => p in FILTERS), {
        // An unregistered provider name (typo, renamed provider, plugin not
        // loaded) is silently skipped at runtime (`if (!fn) continue` in
        // wrap.ts) — the operator believes a PII/credential filter is active
        // while it does nothing (fail-open). Reject unknown names at
        // validation time so the misconfiguration surfaces at deploy.
        message:
          'unknown guardrail provider (not in the filter registry); check for a typo. Known providers: pii',
      })
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
          'value). Unknown provider names are rejected at validation time (they would ' +
          'otherwise be silently skipped, disabling filtering while appearing protected). ' +
          '`bedrock` is reserved for a future AI Gateway content policy hook and is ' +
          'currently rejected at validation time.',
        example: ['pii'],
      }),
    block_on_match: z.boolean().default(false).openapi({
      description: 'When true, a match denies the request. When false, the match is redacted.',
    }),
    targets: z
      .array(z.enum(['input', 'output']))
      .default(['input', 'output'])
      .openapi({
        description: 'Which sides of the conversation are scanned.',
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
  judges: [],
};

export function guardrailsEnabled(g: Guardrails): boolean {
  return g.providers.length > 0;
}

export function judgesEnabled(g: Guardrails): boolean {
  return g.judges.length > 0;
}
