import { z } from '@hono/zod-openapi';

/**
 * Absolute ceilings — a manifest cannot exceed these regardless of what
 * its `limits` block declares. `applyLimits` enforces these even if a
 * (hypothetical) future caller bypasses schema validation.
 */
export const ABSOLUTE_LIMITS = {
  max_tool_calls: 200,
  max_wall_clock_seconds: 600,
  max_peer_hops: 5,
  recursion_limit: 50,
  max_turns: 20,
  // Token ceilings keep cost-per-request bounded across providers. The
  // numbers are deliberately generous — manifests should set tighter caps.
  max_input_tokens: 1_000_000,
  max_output_tokens: 100_000,
} as const;

export const LimitsSchema = z
  .object({
    max_tool_calls: z
      .number()
      .int()
      .min(1)
      .max(ABSOLUTE_LIMITS.max_tool_calls)
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          `Per-run tool call cap. Null means no manifest-level cap (the absolute ceiling of ` +
          `${ABSOLUTE_LIMITS.max_tool_calls} still applies).`,
      }),
    max_wall_clock_seconds: z
      .number()
      .positive()
      .max(ABSOLUTE_LIMITS.max_wall_clock_seconds)
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          `Per-run wall-clock cap (seconds). When the cap fires, the per-request ` +
          `AbortController is aborted — tools that propagate \`ctx.signal\` through to ` +
          `\`fetch(url, { signal })\` cancel mid-flight instead of just being blocked from ` +
          `starting. Peer (A2A) and MCP tools honor the signal by default. Ceiling: ` +
          `${ABSOLUTE_LIMITS.max_wall_clock_seconds}s.`,
      }),
    max_peer_hops: z
      .number()
      .int()
      .min(1)
      .max(ABSOLUTE_LIMITS.max_peer_hops)
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          `Per-run cap on \`peer_*\` tool invocations. The limits wrapper detects the ` +
          `\`peer_\` prefix (or \`isPeer: true\`) and increments \`peerHops\` on every call. ` +
          `Ceiling: ${ABSOLUTE_LIMITS.max_peer_hops}.`,
      }),
    max_input_tokens: z
      .number()
      .int()
      .min(1)
      .max(ABSOLUTE_LIMITS.max_input_tokens)
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          `Cumulative input-token cap across the entire run, checked before each model call. ` +
          `Token usage accumulates on the request-scoped \`LimitState.tokens\`; sub-agents ` +
          `share the same \`LimitState\` so parallel children contribute to the parent's ` +
          `budget. OpenAI's \`cached_tokens\` are subtracted from \`prompt_tokens\` so cache ` +
          `hits don't double-count. Ceiling: ${ABSOLUTE_LIMITS.max_input_tokens.toLocaleString()}.`,
      }),
    max_output_tokens: z
      .number()
      .int()
      .min(1)
      .max(ABSOLUTE_LIMITS.max_output_tokens)
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          `Cumulative output-token cap across the entire run. Ceiling: ` +
          `${ABSOLUTE_LIMITS.max_output_tokens.toLocaleString()}.`,
      }),
    precount: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'When true, every Anthropic-routed model call is preceded by a free ' +
          '`/v1/messages/count_tokens` round-trip. If the projected input would push the ' +
          'cumulative spend past `max_input_tokens`, the call is denied before any paid ' +
          'request is made. Only effective on Anthropic routes (the count endpoint is ' +
          'Anthropic-specific) and only meaningful when `max_input_tokens` is set.',
      }),
  })
  .strict()
  .openapi('Limits');

export type Limits = z.infer<typeof LimitsSchema>;

export function anyLimit(limits: Limits): boolean {
  return (
    limits.max_tool_calls != null ||
    limits.max_wall_clock_seconds != null ||
    limits.max_peer_hops != null ||
    limits.max_input_tokens != null ||
    limits.max_output_tokens != null
  );
}

/**
 * Apply the absolute ceiling to a manifest-declared value. Null/undefined
 * gets the ceiling; values larger than the ceiling are clamped. Used at
 * tool-wrap time to make sure schema bypass can't turn a `recursion_limit:
 * 1e9` into reality.
 */
export function clampLimit(value: number | null | undefined, ceiling: number): number {
  if (value == null || value <= 0) return ceiling;
  return Math.min(value, ceiling);
}

export const DEFAULT_LIMITS: Limits = {
  max_tool_calls: null,
  max_wall_clock_seconds: null,
  max_peer_hops: null,
  max_input_tokens: null,
  max_output_tokens: null,
  precount: false,
};
