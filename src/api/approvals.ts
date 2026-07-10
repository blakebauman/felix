/**
 * /approvals — HITL queue.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { approvalsDoStub } from '../approvals/approvals-do';
import { type ApprovalRequest, ApprovalRequestSchema, ApprovalStatus } from '../approvals/models';
import { getRequest, listRequests } from '../approvals/store';
import { recordEvent } from '../audit/store';
import type { AuthContext } from '../auth/context';
import { requireScope } from '../auth/middleware';
import type { Env } from '../env';
import { BearerSecurity, ErrorBodySchema, PaginatedQuery } from './openapi-shared';

// Read the queue vs. make a decision are separately scoped. `approvals:decide`
// is the human-in-the-loop gate — deliberately distinct from the tenant claim
// so an operator (not the end-user whose agent triggered the call) approves.
const READ_SCOPE = 'approvals:read';
const DECIDE_SCOPE = 'approvals:decide';

const ApprovalDecisionRequestSchema = z
  .object({
    status: z.enum(['approved', 'denied']),
    note: z.string().max(2000).optional(),
    edited_args: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()
  .openapi('ApprovalDecisionRequest', {
    example: { status: 'approved', note: 'Looks good.' },
  });

const listApprovalsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Approvals'],
  summary: 'List approval requests for the authenticated tenant',
  security: BearerSecurity(),
  request: {
    query: PaginatedQuery.extend({
      status: ApprovalStatus.optional().openapi({ description: 'Filter by approval status.' }),
    }),
  },
  responses: {
    200: {
      description: 'Approval requests, newest first.',
      content: {
        'application/json': {
          schema: z
            .object({ requests: z.array(ApprovalRequestSchema) })
            .openapi('ApprovalListResponse'),
        },
      },
    },
  },
});

const getApprovalRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Approvals'],
  summary: 'Fetch a single approval request',
  security: BearerSecurity(),
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Approval request.',
      content: { 'application/json': { schema: ApprovalRequestSchema } },
    },
    404: {
      description: 'No approval with that id for the caller’s tenant.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const decideApprovalRoute = createRoute({
  method: 'post',
  path: '/{id}/decide',
  tags: ['Approvals'],
  summary: 'Approve or deny a pending request',
  description:
    'Concurrent decisions on the same id are serialized through a per-(tenant, id) ' +
    'Durable Object. The system of record stays D1.',
  security: BearerSecurity(),
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { 'application/json': { schema: ApprovalDecisionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Decision applied.',
      content: { 'application/json': { schema: ApprovalRequestSchema } },
    },
    404: {
      description: 'No approval with that id for the caller’s tenant.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    500: {
      description: 'Decision DO failed.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

export function buildApprovalsRouter() {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

  router.openapi(listApprovalsRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { status, limit } = c.req.valid('query');
    const requests = await listRequests(c.env, auth.principal.tenantId, { status, limit });
    return c.json({ requests }, 200);
  });

  router.openapi(getApprovalRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const req = await getRequest(c.env, auth.principal.tenantId, id);
    if (!req) return c.json({ error: 'not found' }, 404);
    return c.json(req, 200);
  });

  router.openapi(decideApprovalRoute, async (c) => {
    const denied = requireScope(c, DECIDE_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    // Pre-check ownership so a probe targeting another tenant's approval
    // returns 404 immediately without locking the DO.
    const owned = await getRequest(c.env, auth.principal.tenantId, id);
    if (!owned) return c.json({ error: 'not found' }, 404);

    // Serialize concurrent decisions on the same approval id by routing
    // through the per-(tenant,id) DO. The DO calls back into
    // `decideRequest` from its critical section, so the system of record
    // is still D1.
    const stub = approvalsDoStub(c.env, auth.principal.tenantId, id);
    const resp = await stub.fetch('https://do/decide', {
      method: 'POST',
      body: JSON.stringify({
        tenantId: auth.principal.tenantId,
        id,
        status: body.status,
        decidedBy: auth.principal.subject,
        note: body.note,
        editedArgs: body.edited_args ?? null,
      }),
    });
    if (resp.status === 404) return c.json({ error: 'not found' }, 404);
    if (!resp.ok) return c.json({ error: await resp.text() }, 500);
    const updated = (await resp.json()) as ApprovalRequest;
    recordEvent({
      tenantId: auth.principal.tenantId,
      eventType: 'approval_decision',
      principalSubject: auth.principal.subject,
      manifestId: updated.manifest_id,
      status: body.status,
      payload: { approval_id: updated.id, tool: updated.tool_name },
    });
    return c.json(updated, 200);
  });

  return router;
}
