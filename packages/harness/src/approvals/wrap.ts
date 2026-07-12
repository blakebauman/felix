/**
 * Approval-gating tool wrappers.
 *
 * On first call we synthesize a deterministic `call_signature` (manifest +
 * tool + canonicalised args), create-or-fetch the request, and return a
 * deny string to the LLM with the approval id. On a retry, the wrapper
 * looks the request up by signature: if approved it forwards the call
 * (with `edited_args` overriding if provided), if denied it returns the
 * operator's note as a deny string.
 */

import { recordEvent } from '../audit/store';
import { getContext } from '../context';
import { currentTenantSubject } from '../limits/state';
import { recordCounter } from '../observability/metrics';
import { wrapExecutor } from '../tools/executor';
import { denyOutput, type Tool, type ToolInput } from '../tools/types';
import type { ApprovalRule } from './models';
import { createOrFetchRequest, findBySignature } from './store';

function canonicalize(args: ToolInput): string {
  const keys = Object.keys(args).sort();
  return JSON.stringify(keys.map((k) => [k, args[k]]));
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function wrapOne(inner: Tool, manifestId: string): Tool {
  return {
    ...inner,
    executor: wrapExecutor(inner.executor, async (args, ctx) => {
      const requestCtx = getContext();
      if (!requestCtx) {
        // The approval store needs `env` (and a tenant) to record/verify a
        // decision. Without a RequestContext we can't confirm the call was
        // approved — fail CLOSED (deny) rather than execute a human-gated tool
        // unapproved. This path is unreachable via HTTP or the durable
        // Workflow (both install a context); it only guards a future invoker
        // that forgets `runWithContext`. Tests that need to skip approvals omit
        // the wrap entirely.
        recordCounter('orchestrator_approvals_no_context', {
          tool: inner.name,
          manifest_id: manifestId,
        });
        return denyOutput(
          `[approval unavailable] tool '${inner.name}' is approval-gated but no request ` +
            'context is present to verify a decision; denying to fail closed.',
          'approvals',
        );
      }
      const env = requestCtx.env;
      const { tenantId, subject } = currentTenantSubject();
      // Canonicalize against the parsed schema view so callers can't bypass
      // approval idempotency by varying extra-keys the tool doesn't declare.
      const parsed = inner.args.safeParse(args);
      const sigArgs = (parsed.success ? (parsed.data as ToolInput) : args) ?? {};
      const callSignature = await sha256Hex(`${manifestId}|${inner.name}|${canonicalize(sigArgs)}`);

      const existing = await findBySignature(env, tenantId, manifestId, inner.name, callSignature);
      if (existing) {
        if (existing.status === 'approved') {
          recordEvent({
            tenantId,
            eventType: 'approval_decision',
            principalSubject: subject,
            manifestId,
            status: 'approved',
            payload: {
              approval_id: existing.id,
              tool: inner.name,
              transport: inner.executor.transport,
            },
          });
          recordCounter('orchestrator_approval_decisions', {
            outcome: 'approved',
            manifest_id: manifestId,
            transport: inner.executor.transport,
          });
          const effective = existing.edited_args ?? args;
          return inner.executor.execute(effective, ctx);
        }
        if (existing.status === 'denied') {
          recordEvent({
            tenantId,
            eventType: 'approval_decision',
            principalSubject: subject,
            manifestId,
            status: 'denied',
            payload: {
              approval_id: existing.id,
              tool: inner.name,
              transport: inner.executor.transport,
            },
          });
          recordCounter('orchestrator_approval_decisions', {
            outcome: 'denied',
            manifest_id: manifestId,
            transport: inner.executor.transport,
          });
          return denyOutput(
            `[approval denied] tool '${inner.name}' was denied by operator: ${existing.decision_note}`,
            'approvals',
          );
        }
        // status == 'pending' — fall through and return the same deny string
      }

      const req = await createOrFetchRequest(env, {
        tenantId,
        manifestId,
        toolName: inner.name,
        callSignature,
        args,
        principalSubject: subject,
      });
      recordEvent({
        tenantId,
        eventType: 'approval_request',
        principalSubject: subject,
        manifestId,
        status: 'pending',
        payload: {
          approval_id: req.id,
          tool: inner.name,
          transport: inner.executor.transport,
        },
      });
      recordCounter('orchestrator_approval_requests', {
        manifest_id: manifestId,
        transport: inner.executor.transport,
      });
      return denyOutput(
        `[approval required] tool '${inner.name}' is gated for human approval (approval_id=${req.id}). Retry later — the operator will decide via /approvals/${req.id}/decide.`,
        'approvals',
      );
    }),
  };
}

export function applyApprovals(tools: Tool[], rules: ApprovalRule[], manifestId: string): Tool[] {
  if (rules.length === 0) return [...tools];
  const gated = new Set<string>();
  for (const r of rules) {
    for (const t of r.tools) gated.add(t);
  }
  return tools.map((t) => (gated.has(t.name) ? wrapOne(t, manifestId) : t));
}
