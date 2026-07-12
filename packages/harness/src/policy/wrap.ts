/**
 * Apply declarative policies to a tool list.
 *
 * Each tool listed under a policy is wrapped so that, on every invocation,
 * the principal's scopes are checked against the policy's required_scopes.
 * Missing scopes produce a deny string + audit event; never throw, so the
 * LLM sees the deny string as the tool output and can recover.
 *
 * Multiple policies on the same tool stack — every applicable policy must pass.
 */

import { recordEvent } from '../audit/store';
import { getContext } from '../context';
import { recordCounter } from '../observability/metrics';
import { wrapExecutor } from '../tools/executor';
import { matchesAnyToolPattern } from '../tools/tool-match';
import { denyOutput, type Tool } from '../tools/types';
import type { Policy } from './models';

function principalScopes(): { scopes: Set<string>; tenantId: string; subject: string } {
  const ctx = getContext();
  if (!ctx) return { scopes: new Set(), tenantId: 'default', subject: '' };
  return {
    scopes: new Set(ctx.auth.principal.scopes),
    tenantId: ctx.auth.principal.tenantId,
    subject: ctx.auth.principal.subject,
  };
}

function wrapOne(inner: Tool, applicable: Policy[], manifestId: string): Tool {
  const required = applicable
    .filter((p) => p.required_scopes.length > 0)
    .map((p) => ({ id: p.id, scopes: p.required_scopes }));

  if (required.length === 0) return inner;

  return {
    ...inner,
    executor: wrapExecutor(inner.executor, async (args, ctx) => {
      const { scopes, tenantId, subject } = principalScopes();
      for (const policy of required) {
        const missing = policy.scopes.filter((s) => !scopes.has(s));
        if (missing.length === 0) continue;
        recordEvent({
          tenantId,
          eventType: 'policy_decision',
          principalSubject: subject,
          manifestId,
          status: 'denied',
          payload: {
            policy_id: policy.id,
            tool: inner.name,
            transport: inner.executor.transport,
            missing_scopes: missing,
            outcome: 'denied',
          },
        });
        recordCounter('orchestrator_policy_decisions', {
          outcome: 'denied',
          policy_id: policy.id,
          manifest_id: manifestId,
          transport: inner.executor.transport,
        });
        return denyOutput(
          `[policy denied] tool '${inner.name}' blocked by policy '${policy.id}': missing scopes ${JSON.stringify(missing)}`,
          'policy',
        );
      }
      return inner.executor.execute(args, ctx);
    }),
  };
}

export function applyPolicies(tools: Tool[], policies: Policy[], manifestId: string): Tool[] {
  if (policies.length === 0) return [...tools];
  return tools.map((t) => {
    // A policy applies when any of its `tools` patterns matches — exact name or
    // a trailing-`*` prefix (`stripe__*` gates a whole MCP server regardless of
    // the server-chosen tool-name suffix).
    const applicable = policies.filter((p) => matchesAnyToolPattern(t.name, p.tools));
    return applicable.length ? wrapOne(t, applicable, manifestId) : t;
  });
}
