/**
 * ApprovalsDO — serializes concurrent decisions on the same approval id so
 * a stampede can't race to overwrite. Reads/writes proxy to D1 — the DO is
 * a critical section, not the system of record.
 */

import type { Env } from '../env';
import type { ApprovalStatus } from './models';
import { decideRequest, getRequest } from './store';

export class ApprovalsDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/decide' && req.method === 'POST') return this.decide(req);
    if (url.pathname === '/get' && req.method === 'GET') return this.get(url);
    return new Response('not found', { status: 404 });
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
    if (!result) return new Response('not found', { status: 404 });
    return Response.json(result);
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
