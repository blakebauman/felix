/**
 * ApprovalsDO — serializes concurrent decisions on the same approval id so
 * a stampede can't race to overwrite. Reads/writes proxy to D1 — the DO is
 * a critical section, not the system of record.
 */

import type { Env } from '../env';
import type { ApprovalStatus } from './models';
import { decideRequest, getRequest, supersedeGrant } from './store';

export class ApprovalsDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/decide' && req.method === 'POST') return this.decide(req);
    if (url.pathname === '/supersede' && req.method === 'POST') return this.supersede(req);
    if (url.pathname === '/get' && req.method === 'GET') return this.get(url);
    return new Response('not found', { status: 404 });
  }

  /**
   * Serialized `approved → consumed | expired` transition. Same critical
   * section as `decide` (keyed per (tenant, approval id)) so a one-shot claim
   * can't race a concurrent retry into a double-execute, and an expiry can't
   * race a decision.
   */
  private async supersede(req: Request): Promise<Response> {
    const body = (await req.json()) as {
      tenantId: string;
      id: string;
      toStatus: 'consumed' | 'expired';
    };
    const changed = await this.state.blockConcurrencyWhile(async () =>
      supersedeGrant(this.env, body.tenantId, body.id, body.toStatus),
    );
    return Response.json({ changed });
  }

  private async decide(req: Request): Promise<Response> {
    const body = (await req.json()) as {
      tenantId: string;
      id: string;
      status: ApprovalStatus;
      decidedBy: string;
      note?: string;
      editedArgs?: Record<string, unknown> | null;
    };
    const result = await this.state.blockConcurrencyWhile(async () =>
      decideRequest(this.env, body.tenantId, body.id, {
        status: body.status,
        decidedBy: body.decidedBy,
        note: body.note,
        editedArgs: body.editedArgs ?? null,
      }),
    );
    if (result.outcome === 'not_found') return new Response('not found', { status: 404 });
    if (result.outcome === 'already_decided') {
      // Finality guard: the request was resolved by an earlier decision.
      // 409 so the REST layer surfaces it rather than reporting success.
      return Response.json(result.request, { status: 409 });
    }
    return Response.json(result.request);
  }

  private async get(url: URL): Promise<Response> {
    const tenantId = url.searchParams.get('tenantId') ?? '';
    const id = url.searchParams.get('id') ?? '';
    const r = await getRequest(this.env, tenantId, id);
    if (!r) return new Response('not found', { status: 404 });
    return Response.json(r);
  }
}

export function approvalsDoStub(env: Env, tenantId: string, approvalId: string): DurableObjectStub {
  // Tenant-prefix the DO key so two tenants can't share (or contend on)
  // the same approvals DO. `#` is rejected from caller-supplied ids
  // elsewhere; using it here as the delimiter keeps the prefix unspoofable.
  const id = env.APPROVALS_DO.idFromName(`${tenantId}#${approvalId}`);
  return env.APPROVALS_DO.get(id);
}

/**
 * Route an `approved → consumed | expired` transition through the per-(tenant,
 * approval id) DO so it's serialized against `decide` and against other
 * supersede attempts on the same grant. Returns true when THIS call performed
 * the transition (the one-shot double-execute guard hinges on this).
 */
export async function supersedeViaDO(
  env: Env,
  tenantId: string,
  approvalId: string,
  toStatus: 'consumed' | 'expired',
): Promise<boolean> {
  const stub = approvalsDoStub(env, tenantId, approvalId);
  const resp = await stub.fetch('https://do/supersede', {
    method: 'POST',
    body: JSON.stringify({ tenantId, id: approvalId, toStatus }),
  });
  if (!resp.ok) return false;
  const { changed } = (await resp.json()) as { changed: boolean };
  return changed;
}
