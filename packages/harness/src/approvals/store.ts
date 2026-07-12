/**
 * Approval store backed by Postgres with a partial unique index on the call
 * signature (live decisions only) so a retry of the same logical invocation
 * maps back to the same pending or resolved request — that's the idempotency
 * contract.
 *
 * Highly-contended decisions can be routed through ApprovalsDO (see
 * `approvals-do.ts`) to serialize writes, but the canonical persisted state
 * lives in Postgres so the `/approvals` REST surface can list across tenants
 * without coordinating across DOs.
 */

import { getDb } from '../db/client';
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
const ACTIVE_STATUSES = ['pending', 'approved', 'denied'];

export async function createOrFetchRequest(
  env: Env,
  input: CreateOrFetchInput,
): Promise<ApprovalRequest> {
  const sql = getDb(env);
  const existing = await sql<ApprovalRow[]>`
    SELECT * FROM approvals
      WHERE tenant_id = ${input.tenantId} AND manifest_id = ${input.manifestId}
        AND tool_name = ${input.toolName} AND call_signature = ${input.callSignature}
        AND status IN ${sql(ACTIVE_STATUSES)}
      LIMIT 1
  `;

  if (existing[0]) return rowToRequest(existing[0]);

  const now = Date.now();
  const id = crypto.randomUUID();
  const ttlSeconds = input.ttlSeconds ?? null;
  // Redact secret-shaped values before persistence — `args_json` is
  // returned by `/approvals/:id` so an operator (or a leak of the row)
  // shouldn't see raw bearer tokens or API keys that happened to be
  // passed as tool arguments.
  const storedArgs = redactSecrets(input.args);
  await sql`
    INSERT INTO approvals
      (id, tenant_id, manifest_id, tool_name, call_signature, args_json,
       principal_subj, status, created_at, ttl_seconds)
      VALUES (${id}, ${input.tenantId}, ${input.manifestId}, ${input.toolName},
              ${input.callSignature}, ${storedArgs as Record<string, unknown>},
              ${input.principalSubject}, 'pending', ${now}, ${ttlSeconds})
  `;

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
  const sql = getDb(env);
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
  const res = await sql`
    UPDATE approvals
      SET status = ${decision.status}, decided_at = ${now},
          decided_by = ${decision.decidedBy}, decision_note = ${decision.note ?? ''},
          edited_args_json = ${decision.editedArgs ?? null},
          expires_at = CASE
            WHEN ${decision.status}::text = 'approved' AND ttl_seconds IS NOT NULL
              THEN ${now}::bigint + (ttl_seconds::bigint * 1000)
            ELSE NULL
          END
      WHERE tenant_id = ${tenantId} AND id = ${id} AND status = 'pending'
  `;

  const current = await getRequest(env, tenantId, id);
  if (!current) return { outcome: 'not_found' };
  if (res.count === 0) return { outcome: 'already_decided', request: current };
  return { outcome: 'decided', request: current };
}

export async function getRequest(
  env: Env,
  tenantId: string,
  id: string,
): Promise<ApprovalRequest | null> {
  const sql = getDb(env);
  const rows = await sql<ApprovalRow[]>`
    SELECT * FROM approvals WHERE tenant_id = ${tenantId} AND id = ${id} LIMIT 1
  `;
  return rows[0] ? rowToRequest(rows[0]) : null;
}

export async function listRequests(
  env: Env,
  tenantId: string,
  opts: { status?: ApprovalStatus; limit?: number } = {},
): Promise<ApprovalRequest[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const sql = getDb(env);
  const rows = await sql<ApprovalRow[]>`
    SELECT * FROM approvals
      WHERE tenant_id = ${tenantId}
      ${opts.status ? sql`AND status = ${opts.status}` : sql``}
      ORDER BY created_at DESC LIMIT ${limit}
  `;
  return rows.map(rowToRequest);
}

export async function findBySignature(
  env: Env,
  tenantId: string,
  manifestId: string,
  toolName: string,
  callSignature: string,
): Promise<ApprovalRequest | null> {
  const sql = getDb(env);
  const rows = await sql<ApprovalRow[]>`
    SELECT * FROM approvals
      WHERE tenant_id = ${tenantId} AND manifest_id = ${manifestId}
        AND tool_name = ${toolName} AND call_signature = ${callSignature}
        AND status IN ${sql(ACTIVE_STATUSES)}
      LIMIT 1
  `;
  return rows[0] ? rowToRequest(rows[0]) : null;
}

/**
 * Terminal transition of an approved grant to `consumed` (one-shot claim) or
 * `expired` (TTL elapsed). Guarded by `status = 'approved'` so it's a one-way
 * move that only the FIRST caller wins — this is the double-execute guard for
 * one-shot grants: serialized through ApprovalsDO, exactly one concurrent retry
 * flips `approved → consumed` (count = 1) and proceeds; the loser sees
 * `count = 0` and re-requests. Returns true when this call performed the
 * transition.
 */
export async function supersedeGrant(
  env: Env,
  tenantId: string,
  id: string,
  toStatus: 'consumed' | 'expired',
): Promise<boolean> {
  const sql = getDb(env);
  const res = await sql`
    UPDATE approvals
      SET status = ${toStatus}
      WHERE tenant_id = ${tenantId} AND id = ${id} AND status = 'approved'
  `;
  return res.count > 0;
}

interface ApprovalRow {
  id: string;
  tenant_id: string;
  manifest_id: string;
  tool_name: string;
  call_signature: string;
  args_json: Record<string, unknown>;
  principal_subj: string;
  status: ApprovalStatus;
  created_at: number;
  decided_at: number | null;
  decided_by: string;
  decision_note: string;
  edited_args_json: Record<string, unknown> | null;
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
    args: row.args_json ?? {},
    principal_subject: row.principal_subj,
    status: row.status,
    created_at: row.created_at,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    decision_note: row.decision_note,
    edited_args: row.edited_args_json ?? null,
    expires_at: row.expires_at ?? null,
  });
}
