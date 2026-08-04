/**
 * Declarative screening of shell commands before a tool executes them.
 *
 * A manifest that exposes a `sandbox` / `container` tool hands the model an
 * execution surface. `command_screening` puts a rule list in front of it:
 * every command-shaped argument is normalized (see `command-scan.ts`) and
 * matched against the rules, and the first match decides.
 *
 * Three decisions:
 *   - `allow`            — proceed (an explicit carve-out ahead of a broader rule)
 *   - `require_approval` — route through the human approval surface
 *   - `deny`             — refuse outright, no approval path
 *
 * Built-in floor rules are prepended by default and therefore win over
 * manifest rules. That ordering is deliberate: an author who needs an
 * exception disables the floor explicitly (`include_defaults: false`), which
 * is visible in the manifest and in review, rather than quietly shadowing a
 * destructive-command rule with an `allow`.
 */

import { z } from '@hono/zod-openapi';
import { compileSafeRegex } from '../security/safe-regex';
import { scannableCommand } from './command-scan';

export const CommandDecision = z
  .enum(['allow', 'deny', 'require_approval'])
  .openapi('CommandDecision');
export type CommandDecision = z.infer<typeof CommandDecision>;

export const CommandRuleSchema = z
  .object({
    pattern: z
      .string()
      .min(1)
      .refine(
        (p) => {
          try {
            compileSafeRegex(p, 'i');
            return true;
          } catch {
            return false;
          }
        },
        {
          // A pattern that can't compile safely would be skipped at runtime,
          // leaving the operator believing a rule is active while it does
          // nothing. Reject at validation time instead (fail-closed on config).
          message:
            'pattern must be a regex under 256 chars with no backreferences, lookarounds, or nested ' +
            'quantifiers (catastrophic-backtracking guard)',
        },
      )
      .openapi({
        description:
          'Case-insensitive regex matched against the NORMALIZED command (quoting resolved, ' +
          'nested interpreter payloads expanded). Anchors apply per payload line.',
        example: '\\bcurl\\b.*\\|\\s*(sh|bash)\\b',
      }),
    decision: CommandDecision.openapi({
      description:
        'What happens on a match. `deny` refuses with no recourse; `require_approval` opens a ' +
        'human approval request keyed on the RULE (not the literal command); `allow` short-circuits ' +
        'later rules.',
    }),
    reason: z.string().optional().openapi({
      description: 'Operator-facing explanation, surfaced to the model and written to audit.',
      example: 'pipe-to-shell',
    }),
  })
  .strict()
  .openapi('CommandRule');

export type CommandRule = z.infer<typeof CommandRuleSchema>;

/**
 * Always-on floor. Everything here is `require_approval` rather than `deny`
 * except the two that have no legitimate agent use — a destructive default
 * that can't be worked around is a support burden, while a pause a human can
 * clear is not.
 */
export const DEFAULT_COMMAND_RULES: CommandRule[] = [
  {
    pattern: '\\brm\\b[^\\n]*(?:-[a-zA-Z]*r|--recursive)',
    decision: 'require_approval',
    reason: 'recursive delete',
  },
  {
    pattern: '\\bgit\\s+push\\b.*(?:--force\\b|(?:^|\\s)-[a-zA-Z]*f\\b)',
    decision: 'require_approval',
    reason: 'force push',
  },
  {
    pattern: '\\b(drop|truncate)\\s+table\\b',
    decision: 'require_approval',
    reason: 'destructive SQL',
  },
  {
    // Any fetcher piped into any shell — `\S*sh` covers `sh`, `bash`, `zsh`,
    // and absolute paths like `/bin/bash`. Restricting this to `curl` would
    // leave the identical `wget -qO- … | sh` attack wide open.
    pattern: '\\b(?:curl|wget|fetch)\\b[^\\n]*\\|\\s*(?:sudo\\s)?\\S*sh\\b',
    decision: 'require_approval',
    reason: 'pipe-to-shell',
  },
  {
    pattern: '\\bmkfs\\b|:\\(\\)\\s*\\{',
    decision: 'deny',
    reason: 'filesystem format / fork bomb',
  },
  {
    // Device naming varies by platform: `xvd*` on Xen/EC2, `mmcblk*` on
    // eMMC/SD, `hd*` on older kernels. Missing one means missing the root
    // volume on exactly the hosts where this is most destructive.
    pattern: '\\bdd\\b[^\\n]*\\bof=/dev/(?:sd|nvme|disk|vd|xvd|hd|mmcblk|loop|ram)',
    decision: 'deny',
    reason: 'raw block-device write',
  },
];

export const CommandScreeningSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'Off by default. When enabled, command-shaped arguments to the tools selected below are ' +
          'normalized and matched against the rule list before the tool runs.',
      }),
    mode: z
      .enum(['denylist', 'allowlist'])
      .default('denylist')
      .openapi({
        description:
          '`denylist` (default) allows anything no rule matches. `allowlist` denies anything no ' +
          'rule matches — only commands explicitly matched by an `allow` rule get through.',
      }),
    tools: z
      .array(z.string())
      .default([])
      .openapi({
        description:
          'Tool-name patterns to screen (exact name or trailing `*` prefix). When empty, every ' +
          'tool whose transport is `sandbox` or `container` is screened — the transports that ' +
          'execute commands.',
        example: ['sandbox_exec', 'container_*'],
      }),
    arg_names: z
      .array(z.string())
      .default([])
      .openapi({
        description:
          'Argument names holding the command. When empty (default), EVERY string argument is ' +
          'screened, including strings nested in arrays — the safe default, since a tool that ' +
          'takes `{argv: ["-c", "rm -rf /"]}` would otherwise slip past a name-based check.',
        example: ['command'],
      }),
    include_defaults: z
      .boolean()
      .default(true)
      .openapi({
        description:
          'Prepend the built-in floor rules (recursive delete, force push, destructive SQL, ' +
          'pipe-to-shell, mkfs / fork bomb, raw block-device write). They are evaluated BEFORE ' +
          'manifest rules, so a manifest `allow` cannot shadow them — set this false to opt out ' +
          'explicitly and visibly.',
      }),
    rules: z.array(CommandRuleSchema).default([]).openapi({
      description:
        'Manifest rules, evaluated in declaration order after the floor rules. First match wins.',
    }),
  })
  .strict()
  .openapi('CommandScreening');

export type CommandScreening = z.infer<typeof CommandScreeningSchema>;

export const DEFAULT_COMMAND_SCREENING: CommandScreening = {
  enabled: false,
  mode: 'denylist',
  tools: [],
  arg_names: [],
  include_defaults: true,
  rules: [],
};

export function commandScreeningEnabled(c: CommandScreening): boolean {
  return c.enabled;
}

/** Full rule list in evaluation order: floor rules first, then manifest rules. */
export function effectiveRules(config: CommandScreening): CommandRule[] {
  return config.include_defaults ? [...DEFAULT_COMMAND_RULES, ...config.rules] : [...config.rules];
}

export interface CommandEvaluation {
  decision: CommandDecision;
  reason?: string;
  /** The substring that matched — surfaced to the operator, never used as an identity. */
  matched?: string;
  /**
   * Stable key for an approval grant: the RULE pattern, not the command. A
   * human approving `rm -rf ./build` is approving the recursive-delete rule for
   * this manifest+tool, so the next recursive delete does not re-prompt. Keying
   * on the literal command would make approvals useless in practice (every
   * path variation re-prompts) — and keying on nothing would make one approval
   * authorize every rule.
   */
  approvalKey?: string;
}

function firstMatch(scannable: string, rules: readonly CommandRule[]): CommandEvaluation | null {
  for (const rule of rules) {
    let re: RegExp;
    try {
      // `m` so `^` / `$` anchor per payload line: the normalized projection is
      // newline-joined (base command, quoted payloads, each executed payload),
      // and an anchored rule is meant to apply to each of those, not only to
      // the very start of the projection.
      re = compileSafeRegex(rule.pattern, 'im');
    } catch {
      // Unreachable for manifest-validated rules (the schema rejects these at
      // parse time); reachable for a federation bundle written by an older
      // build. Skip rather than fail the call, and make the skip loud.
      console.error(
        `[command-screening] skipping uncompilable rule pattern ${JSON.stringify(rule.pattern)} (${rule.decision})`,
      );
      continue;
    }
    const hit = re.exec(scannable);
    if (hit) {
      return {
        decision: rule.decision,
        ...(rule.reason ? { reason: rule.reason } : {}),
        matched: hit[0],
        approvalKey: rule.pattern,
      };
    }
  }
  return null;
}

/**
 * Evaluate one command against the configured rules.
 *
 * `command` is normalized first, so evasion via quoting, `eval`, nested
 * interpreters, pipe-to-shell, here-strings, and wrapper chains still matches.
 */
export function evaluateCommand(command: string, config: CommandScreening): CommandEvaluation {
  const matched = firstMatch(scannableCommand(command), effectiveRules(config));
  if (matched) return matched;
  if (config.mode === 'allowlist') {
    return { decision: 'deny', reason: 'not in allowlist' };
  }
  return { decision: 'allow' };
}
