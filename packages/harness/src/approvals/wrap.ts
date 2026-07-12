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
import { matchesAnyToolPattern } from '../tools/tool-match';
import { denyOutput, type Tool, type ToolInput } from '../tools/types';
import { supersedeViaDO } from './approvals-do';
import type { ApprovalRule } from './models';
import { createOrFetchRequest, findBySignature } from './store';

/**
 * Effective config for a gated tool, distilled from the FIRST matching rule
 * (see `applyApprovals`). Defaults keep pre-existing behavior: no expiry,
 * replayable grant, tenant-wide (subject-agnostic) signature.
 */
interface GateConfig {
  ttlSeconds: number | null;
  oneShot: boolean;
  bindPrincipal: boolean;
}

function canonicalize(args: ToolInput): string {
  const keys = Object.keys(args).sort();
  return JSON.stringify(keys.map((k) => [k, args[k]]));
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function wrapOne(inner: Tool, manifestId: string, config: GateConfig): Tool {
  const { ttlSeconds, oneShot, bindPrincipal } = config;
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
      // `bind_principal` mixes the requesting subject into the signature so a
      // grant approved for one subject yields a DIFFERENT signature for another
      // — a different user must re-request. Default (off) keeps the tenant-wide
      // subject-agnostic signature so existing manifests behave unchanged.
      const sigInput = bindPrincipal
        ? `${manifestId}|${subject}|${inner.name}|${canonicalize(sigArgs)}`
        : `${manifestId}|${inner.name}|${canonicalize(sigArgs)}`;
      const callSignature = await sha256Hex(sigInput);

      const emitApproved = (approvalId: string) => {
        recordEvent({
          tenantId,
          eventType: 'approval_decision',
          principalSubject: subject,
          manifestId,
          status: 'approved',
          payload: {
            approval_id: approvalId,
            tool: inner.name,
            transport: inner.executor.transport,
          },
        });
        recordCounter('orchestrator_approval_decisions', {
          outcome: 'approved',
          manifest_id: manifestId,
          transport: inner.executor.transport,
        });
      };

      const existing = await findBySignature(env, tenantId, manifestId, inner.name, callSignature);
      if (existing) {
        if (existing.status === 'approved') {
          const now = Date.now();
          const isExpired = existing.expires_at != null && existing.expires_at <= now;
          if (isExpired) {
            // TTL elapsed — supersede the stale grant (approved → expired) so it
            // no longer authorizes and a fresh request can reuse the signature,
            // then fall through to re-request. Serialized through the DO so an
            // expiry can't race a concurrent decision.
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
              },
            });
            recordCounter('orchestrator_approval_grants_expired', {
              manifest_id: manifestId,
              transport: inner.executor.transport,
            });
            // fall through to create-fresh-request below
          } else if (oneShot) {
            // Claim the grant (approved → consumed) BEFORE running the tool, so
            // two concurrent retries can never both execute — the DO serializes
            // and only the winner (changed === true) proceeds. The loser
            // re-requests. This spends the grant on the attempt by design.
            const claimed = await supersedeViaDO(env, tenantId, existing.id, 'consumed');
            if (claimed) {
              recordEvent({
                tenantId,
                eventType: 'approval_consumed',
                principalSubject: subject,
                manifestId,
                status: 'consumed',
                payload: {
                  approval_id: existing.id,
                  tool: inner.name,
                  transport: inner.executor.transport,
                },
              });
              recordCounter('orchestrator_approval_grants_consumed', {
                manifest_id: manifestId,
                transport: inner.executor.transport,
              });
              emitApproved(existing.id);
              const effective = existing.edited_args ?? args;
              return inner.executor.execute(effective, ctx);
            }
            // lost the claim — fall through to re-request below
          } else {
            // Reusable (non-expiring, multi-use) grant — the pre-existing path.
            emitApproved(existing.id);
            const effective = existing.edited_args ?? args;
            return inner.executor.execute(effective, ctx);
          }
        } else if (existing.status === 'denied') {
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
        ttlSeconds,
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

/**
 * The gate config for a tool comes from the FIRST rule whose `tools` pattern
 * matches (manifest declaration order). When several rules could match one
 * tool, first-match wins — deterministic and predictable for an author reading
 * the manifest top-to-bottom. Returns null when no rule matches (tool not
 * gated).
 */
function matchRuleConfig(toolName: string, rules: ApprovalRule[]): GateConfig | null {
  const rule = rules.find((r) => matchesAnyToolPattern(toolName, r.tools));
  if (!rule) return null;
  return {
    ttlSeconds: rule.ttl_seconds ?? null,
    oneShot: rule.one_shot ?? false,
    bindPrincipal: rule.bind_principal ?? false,
  };
}

export function applyApprovals(tools: Tool[], rules: ApprovalRule[], manifestId: string): Tool[] {
  if (rules.length === 0) return [...tools];
  // A tool is gated when any rule's `tools` pattern matches — exact name or a
  // trailing-`*` prefix (`stripe__*` gates a whole MCP server regardless of the
  // server-chosen tool-name suffix). The first matching rule supplies the
  // TTL / one-shot / principal-binding config.
  return tools.map((t) => {
    const config = matchRuleConfig(t.name, rules);
    return config ? wrapOne(t, manifestId, config) : t;
  });
}
