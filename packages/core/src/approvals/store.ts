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
}

export async function createOrFetchRequest(
  env: Env,
  input: CreateOrFetchInput,
): Promise<ApprovalRequest> {
  const existing = await env.DB.prepare(
    `SELECT * FROM approvals
       WHERE tenant_id = ? AND manifest_id = ? AND tool_name = ? AND call_signature = ?
       LIMIT 1`,
  )
    .bind(input.tenantId, input.manifestId, input.toolName, input.callSignature)
    .first<ApprovalRow>();

  if (existing) return rowToRequest(existing);

  const now = Date.now();
  const id = crypto.randomUUID();
  // Redact secret-shaped values before persistence — `args_json` is
  // returned by `/approvals/:id` so an operator (or a leak of the row)
  // shouldn't see raw bearer tokens or API keys that happened to be
  // passed as tool arguments.
  const storedArgs = redactSecrets(input.args);
  await env.DB.prepare(
    `INSERT INTO approvals
       (id, tenant_id, manifest_id, tool_name, call_signature, args_json,
        principal_subj, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
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
  });
}

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
): Promise<ApprovalRequest | null> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE approvals
       SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, edited_args_json = ?
       WHERE tenant_id = ? AND id = ?`,
  )
    .bind(
      decision.status,
      now,
      decision.decidedBy,
      decision.note ?? '',
      decision.editedArgs ? JSON.stringify(decision.editedArgs) : null,
      tenantId,
      id,
    )
    .run();
  return getRequest(env, tenantId, id);
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
       LIMIT 1`,
  )
    .bind(tenantId, manifestId, toolName, callSignature)
    .first<ApprovalRow>();
  return row ? rowToRequest(row) : null;
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
  });
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
