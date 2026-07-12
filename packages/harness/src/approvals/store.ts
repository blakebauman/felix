/**
 * Approval store backed by D1 with a unique index on the call signature so
 * a retry of the same logical invocation maps back to the same pending or
 * resolved request — that's the idempotency contract.
 *
 * Highly-contended decisions can be routed through ApprovalsDO (see
 * `approvals-do.ts`) to serialize writes, but the canonical persisted state
 * lives in D1 so the `/approvals` REST surface can list across tenants
 * without coordinating across DOs.
 */

import type { Env } from '../env';
import { redactSecrets } from '../security/redact';
import { type ApprovalRequest, ApprovalRequestSchema, type ApprovalStatus } from './models';

export interface CreateOrFetchInput {
  tenantId: string;
  manifestId: string;
  toolName: string;
  callSignature: string;
  args: Record<string, unknown>;
  principalSubject: string;
  /**
   * The matching rule's `ttl_seconds`, stamped on the pending row so the DECIDE
   * transition can compute `expires_at` without knowing the rule. Null / omitted
   * means the eventual grant never expires.
   */
  ttlSeconds?: number | null;
}

// Only these statuses represent a "live" decision. `consumed` / `expired` rows
// are archived history — a lookup must ignore them so a spent or stale grant is
// treated as absent (re-request), and a fresh row can reuse the signature.
const ACTIVE_STATUSES = "('pending', 'approved', 'denied')";

export async function createOrFetchRequest(
  env: Env,
  input: CreateOrFetchInput,
): Promise<ApprovalRequest> {
  const existing = await env.DB.prepare(
    `SELECT * FROM approvals
       WHERE tenant_id = ? AND manifest_id = ? AND tool_name = ? AND call_signature = ?
         AND status IN ${ACTIVE_STATUSES}
       LIMIT 1`,
  )
    .bind(input.tenantId, input.manifestId, input.toolName, input.callSignature)
    .first<ApprovalRow>();

  if (existing) return rowToRequest(existing);

  const now = Date.now();
  const id = crypto.randomUUID();
  const ttlSeconds = input.ttlSeconds ?? null;
  // Redact secret-shaped values before persistence — `args_json` is
  // returned by `/approvals/:id` so an operator (or a leak of the row)
  // shouldn't see raw bearer tokens or API keys that happened to be
  // passed as tool arguments.
  const storedArgs = redactSecrets(input.args);
  await env.DB.prepare(
    `INSERT INTO approvals
       (id, tenant_id, manifest_id, tool_name, call_signature, args_json,
        principal_subj, status, created_at, ttl_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      id,
      input.tenantId,
      input.manifestId,
      input.toolName,
      input.callSignature,
      JSON.stringify(storedArgs),
      input.principalSubject,
      now,
      ttlSeconds,
    )
    .run();

  return ApprovalRequestSchema.parse({
    id,
    tenant_id: input.tenantId,
    manifest_id: input.manifestId,
    tool_name: input.toolName,
    call_signature: input.callSignature,
    args: storedArgs,
    principal_subject: input.principalSubject,
    status: 'pending',
    created_at: now,
    decided_at: null,
    decided_by: '',
    decision_note: '',
    edited_args: null,
    expires_at: null,
  });
}

/**
 * Result of a decide attempt.
 *
 *   - `decided`         — the pending request transitioned to the new status.
 *   - `already_decided` — the request exists but was NOT pending; nothing was
 *                         changed. This is the finality guard: a decision is a
 *                         one-way transition, so an operator can't flip an
 *                         approved request to denied or re-approve it with
 *                         different `edited_args` on a later call.
 *   - `not_found`       — no such request for this tenant.
 */
export type DecideOutcome =
  | { outcome: 'decided'; request: ApprovalRequest }
  | { outcome: 'already_decided'; request: ApprovalRequest }
  | { outcome: 'not_found' };

export async function decideRequest(
  env: Env,
  tenantId: string,
  id: string,
  decision: {
    status: ApprovalStatus;
    decidedBy: string;
    note?: string;
    editedArgs?: Record<string, unknown> | null;
  },
): Promise<DecideOutcome> {
  const now = Date.now();
  // `AND status = 'pending'` makes the decision a one-way transition: a
  // second decide (or a concurrent one that lost the DO's critical-section
  // race) changes zero rows instead of overwriting the resolved decision or
  // its `edited_args`. Without this, any principal with `approvals:decide`
  // could re-decide a resolved request and mutate the args the tool re-runs
  // on retry.
  // Compute `expires_at` here (not at request-creation) because the grant clock
  // starts when the operator decides, not when the agent asked. `ttl_seconds`
  // was stamped on the row at creation from the matching rule; on approval with
  // a TTL, expiry = decided_at + ttl_seconds*1000. Denials never expire (null).
  const res = await env.DB.prepare(
    `UPDATE approvals
       SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, edited_args_json = ?,
           expires_at = CASE
             WHEN ? = 'approved' AND ttl_seconds IS NOT NULL THEN ? + (ttl_seconds * 1000)
             ELSE NULL
           END
       WHERE tenant_id = ? AND id = ? AND status = 'pending'`,
  )
    .bind(
      decision.status,
      now,
      decision.decidedBy,
      decision.note ?? '',
      decision.editedArgs ? JSON.stringify(decision.editedArgs) : null,
      decision.status,
      now,
      tenantId,
      id,
    )
    .run();

  const current = await getRequest(env, tenantId, id);
  if (!current) return { outcome: 'not_found' };
  if ((res.meta?.changes ?? 0) === 0) return { outcome: 'already_decided', request: current };
  return { outcome: 'decided', request: current };
}

export async function getRequest(
  env: Env,
  tenantId: string,
  id: string,
): Promise<ApprovalRequest | null> {
  const row = await env.DB.prepare('SELECT * FROM approvals WHERE tenant_id = ? AND id = ? LIMIT 1')
    .bind(tenantId, id)
    .first<ApprovalRow>();
  return row ? rowToRequest(row) : null;
}

export async function listRequests(
  env: Env,
  tenantId: string,
  opts: { status?: ApprovalStatus; limit?: number } = {},
): Promise<ApprovalRequest[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const stmt = opts.status
    ? env.DB.prepare(
        `SELECT * FROM approvals
           WHERE tenant_id = ? AND status = ?
           ORDER BY created_at DESC LIMIT ?`,
      ).bind(tenantId, opts.status, limit)
    : env.DB.prepare(
        `SELECT * FROM approvals
           WHERE tenant_id = ?
           ORDER BY created_at DESC LIMIT ?`,
      ).bind(tenantId, limit);
  const rows = await stmt.all<ApprovalRow>();
  return (rows.results ?? []).map(rowToRequest);
}

export async function findBySignature(
  env: Env,
  tenantId: string,
  manifestId: string,
  toolName: string,
  callSignature: string,
): Promise<ApprovalRequest | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM approvals
       WHERE tenant_id = ? AND manifest_id = ? AND tool_name = ? AND call_signature = ?
         AND status IN ${ACTIVE_STATUSES}
       LIMIT 1`,
  )
    .bind(tenantId, manifestId, toolName, callSignature)
    .first<ApprovalRow>();
  return row ? rowToRequest(row) : null;
}

/**
 * Terminal transition of an approved grant to `consumed` (one-shot claim) or
 * `expired` (TTL elapsed). Guarded by `status = 'approved'` so it's a one-way
 * move that only the FIRST caller wins — this is the double-execute guard for
 * one-shot grants: serialized through ApprovalsDO, exactly one concurrent retry
 * flips `approved → consumed` (changes = 1) and proceeds; the loser sees
 * `changes = 0` and re-requests. Returns true when this call performed the
 * transition.
 */
export async function supersedeGrant(
  env: Env,
  tenantId: string,
  id: string,
  toStatus: 'consumed' | 'expired',
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE approvals
       SET status = ?
       WHERE tenant_id = ? AND id = ? AND status = 'approved'`,
  )
    .bind(toStatus, tenantId, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

interface ApprovalRow {
  id: string;
  tenant_id: string;
  manifest_id: string;
  tool_name: string;
  call_signature: string;
  args_json: string;
  principal_subj: string;
  status: ApprovalStatus;
  created_at: number;
  decided_at: number | null;
  decided_by: string;
  decision_note: string;
  edited_args_json: string | null;
  ttl_seconds: number | null;
  expires_at: number | null;
}

function rowToRequest(row: ApprovalRow): ApprovalRequest {
  return ApprovalRequestSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    manifest_id: row.manifest_id,
    tool_name: row.tool_name,
    call_signature: row.call_signature,
    args: safeJson(row.args_json),
    principal_subject: row.principal_subj,
    status: row.status,
    created_at: row.created_at,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    decision_note: row.decision_note,
    edited_args: row.edited_args_json ? safeJson(row.edited_args_json) : null,
    expires_at: row.expires_at ?? null,
  });
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
