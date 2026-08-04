/**
 * Command-screening executor wrapper.
 *
 * Sits between `applyPolicies` and `applyLimits` in the governance chain:
 * after the cheap scope check, before anything that costs a model call or a
 * network round trip. A denied command should never consume a limits budget.
 *
 * `require_approval` opens a request on the SAME approvals surface as
 * `spec.approvals`, so an operator sees one queue and one `/approvals/:id/decide`
 * endpoint regardless of which control asked. The call signature is derived
 * from the matched RULE rather than the arguments, which is what makes an
 * approval reusable: approving `rm -rf ./dist` clears the recursive-delete rule
 * for this manifest+tool instead of only that exact path.
 *
 * This wrapper cannot itself be the reason a dangerous command runs — every
 * path that can't reach a decision (no request context, unreadable arguments)
 * denies.
 */

import { supersedeViaDO } from '../approvals/approvals-do';
import { createOrFetchRequest, findBySignature } from '../approvals/store';
import { recordEvent } from '../audit/store';
import { getContext } from '../context';
import { currentTenantSubject } from '../limits/state';
import { recordCounter } from '../observability/metrics';
import { scrubSecretSubstrings, scrubSecretsDeep } from '../security/redact';
import { wrapExecutor } from '../tools/executor';
import { matchesAnyToolPattern } from '../tools/tool-match';
import { denyOutput, type Tool, type ToolInput, type ToolOutput } from '../tools/types';
import type { CommandEvaluation, CommandScreening } from './command-models';
import { evaluateCommand } from './command-models';

/** Transports that execute commands — the default screening target. */
const COMMAND_TRANSPORTS = new Set(['sandbox', 'container']);

/** Depth cap when harvesting strings out of nested tool arguments. */
const MAX_ARG_DEPTH = 4;

/** One command-shaped argument value, with the path that produced it for audit. */
interface CommandArg {
  path: string;
  value: string;
}

/**
 * Collect the strings to screen out of a tool's arguments.
 *
 * With `arg_names` configured, only those keys are read (at any depth). With
 * it empty — the default — every string is collected, because a tool that
 * takes `{ argv: ['-c', 'rm -rf /'] }` or `{ opts: { cmd: '…' } }` would
 * otherwise walk straight past a name-based check. Over-collecting risks a
 * false positive on an unrelated string; under-collecting risks executing the
 * thing the rule exists to stop.
 */
export function collectCommandArgs(
  args: unknown,
  argNames: string[],
  path = '',
  depth = 0,
  selected = argNames.length === 0,
): CommandArg[] {
  if (depth > MAX_ARG_DEPTH) return [];
  if (typeof args === 'string') {
    return selected && args.trim() ? [{ path: path || '<root>', value: args }] : [];
  }
  if (Array.isArray(args)) {
    return args.flatMap((item, i) =>
      collectCommandArgs(item, argNames, `${path}[${i}]`, depth + 1, selected),
    );
  }
  if (args && typeof args === 'object') {
    return Object.entries(args as Record<string, unknown>).flatMap(([key, value]) =>
      collectCommandArgs(
        value,
        argNames,
        path ? `${path}.${key}` : key,
        depth + 1,
        selected || argNames.includes(key),
      ),
    );
  }
  return [];
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when this tool should be screened under `config`. */
export function screensTool(tool: Tool, config: CommandScreening): boolean {
  if (config.tools.length) return matchesAnyToolPattern(tool.name, config.tools);
  return COMMAND_TRANSPORTS.has(tool.executor.transport);
}

function wrapOne(inner: Tool, config: CommandScreening, manifestId: string): Tool {
  return {
    ...inner,
    executor: wrapExecutor(inner.executor, async (args, ctx) => {
      const requestCtx = getContext();
      if (!requestCtx) {
        // `require_approval` needs `env` to record and verify a decision, and a
        // screening control that silently no-ops is worse than one that
        // refuses. Unreachable over HTTP or the durable Workflow (both install
        // a context); this guards a future invoker that forgets it.
        recordCounter('orchestrator_command_screen_no_context', {
          tool: inner.name,
          manifest_id: manifestId,
        });
        return denyOutput(
          `[command screening unavailable] tool '${inner.name}' screens commands before ` +
            'execution but no request context is present to record a decision; denying to fail closed.',
          'policy',
        );
      }

      const { tenantId, subject } = currentTenantSubject();
      const commands = collectCommandArgs(args as ToolInput, config.arg_names);

      const emit = (outcome: string, evaluation: CommandEvaluation, argPath: string) => {
        recordEvent({
          tenantId,
          eventType: 'command_screened',
          principalSubject: subject,
          manifestId,
          status: outcome,
          payload: {
            tool: inner.name,
            transport: inner.executor.transport,
            arg_path: argPath,
            outcome,
            decision: evaluation.decision,
            ...(evaluation.reason ? { reason: evaluation.reason } : {}),
            // The matched substring, scrubbed and truncated. A greedy rule
            // (`curl .*\| *sh`) matches most of the command line, and a command
            // line is exactly where a credential appears as a SUBSTRING —
            // `redactSecrets` only catches whole-value secrets, so it would let
            // `https://u:sk-ant-…@host` through untouched.
            ...(evaluation.matched
              ? { matched: scrubSecretSubstrings(evaluation.matched).slice(0, 200) }
              : {}),
            ...(evaluation.approvalKey ? { rule: evaluation.approvalKey } : {}),
          },
        });
        recordCounter('orchestrator_command_screened', {
          outcome,
          manifest_id: manifestId,
          transport: inner.executor.transport,
        });
      };

      // Evaluate every command-shaped argument; the strictest outcome wins.
      // `deny` short-circuits, `require_approval` is remembered and applied
      // after all arguments are checked so a deny later in the list still wins.
      let pendingApproval: { evaluation: CommandEvaluation; path: string } | null = null;

      for (const command of commands) {
        const evaluation = evaluateCommand(command.value, config);
        if (evaluation.decision === 'allow') continue;
        if (evaluation.decision === 'deny') {
          emit('denied', evaluation, command.path);
          return denyOutput(
            `[command denied] tool '${inner.name}' blocked by command screening` +
              `${evaluation.reason ? `: ${evaluation.reason}` : ''}. This command cannot be approved — ` +
              'rewrite it or use a different approach.',
            'policy',
          );
        }
        pendingApproval ??= { evaluation, path: command.path };
      }

      if (!pendingApproval) return inner.executor.execute(args, ctx);

      const { evaluation, path: argPath } = pendingApproval;
      const env = requestCtx.env;
      // Keyed on the rule, so one decision covers the rule for this
      // manifest+tool rather than one literal command string. `approvalKey` is
      // always set on a rule match (see `firstMatch`); the `??` is only here so
      // a future decision source without a rule still yields a stable key
      // rather than colliding with every other keyless entry.
      const callSignature = await sha256Hex(
        `command_screening|${manifestId}|${inner.name}|${evaluation.approvalKey ?? `reason:${evaluation.reason ?? 'unknown'}`}`,
      );

      const existing = await findBySignature(env, tenantId, manifestId, inner.name, callSignature);
      if (existing?.status === 'approved') {
        const isExpired = existing.expires_at != null && existing.expires_at <= Date.now();
        if (!isExpired) {
          emit('approved', evaluation, argPath);
          return inner.executor.execute(args, ctx);
        }
        // TTL elapsed — retire the stale grant so it stops authorizing, then
        // fall through and re-request.
        await supersedeViaDO(env, tenantId, existing.id, 'expired');
        recordEvent({
          tenantId,
          eventType: 'approval_expired',
          principalSubject: subject,
          manifestId,
          status: 'expired',
          payload: {
            approval_id: existing.id,
            tool: inner.name,
            transport: inner.executor.transport,
            source: 'command_screening',
          },
        });
      } else if (existing?.status === 'denied') {
        emit('denied', evaluation, argPath);
        return denyOutput(
          `[command denied] tool '${inner.name}' was denied by operator: ${existing.decision_note}`,
          'approvals',
        );
      }

      const req = await createOrFetchRequest(env, {
        tenantId,
        manifestId,
        toolName: inner.name,
        callSignature,
        // The operator has to READ the command to decide on it, so it can't be
        // blanket-redacted — scrub embedded credentials instead and leave the
        // command legible. `createOrFetchRequest` additionally runs its own
        // whole-value `redactSecrets` pass over this.
        args: scrubSecretsDeep(args as Record<string, unknown>),
        principalSubject: subject,
      });
      emit('approval_required', evaluation, argPath);
      return denyOutput(
        `[approval required] tool '${inner.name}' matched a screened command pattern` +
          `${evaluation.reason ? ` (${evaluation.reason})` : ''} and needs human approval ` +
          `(approval_id=${req.id}). Retry after the operator decides via /approvals/${req.id}/decide.`,
        'approvals',
      ) as ToolOutput;
    }),
  };
}

/**
 * Wrap every tool the config selects. Tools that don't execute commands are
 * returned untouched — screening a `local` tool's string arguments would be
 * pure false-positive surface.
 */
export function applyCommandScreening(
  tools: Tool[],
  config: CommandScreening,
  manifestId: string,
): Tool[] {
  if (!config.enabled) return [...tools];
  return tools.map((t) => (screensTool(t, config) ? wrapOne(t, config, manifestId) : t));
}
