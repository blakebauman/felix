/**
 * /audit — tenant-scoped audit event log.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { getToolCallMetrics } from '../audit/aggregations';
import { AuditEventSchema } from '../audit/models';
import { listEvents } from '../audit/store';
import type { AuthContext } from '../auth/context';
import { requireScope } from '../auth/middleware';
import type { Env } from '../env';
import { BearerSecurity, PaginatedQuery } from './openapi-shared';

const READ_SCOPE = 'audit:read';

const listAuditRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Audit'],
  summary: 'List audit events for the authenticated tenant',
  description:
    'Returns the most recent audit events for the caller’s tenant, newest first. ' +
    'Filter by `status` (e.g. `denied`) and cap the page with `limit`.',
  security: BearerSecurity(),
  request: {
    query: PaginatedQuery.extend({
      status: z
        .string()
        .optional()
        .openapi({ description: 'Filter by event status (e.g. `denied`).', example: 'denied' }),
    }),
  },
  responses: {
    200: {
      description: 'Recent audit events.',
      content: {
        'application/json': {
          schema: z.object({ events: z.array(AuditEventSchema) }).openapi('AuditListResponse'),
        },
      },
    },
  },
});

/**
 * `error_code` slices on `tool_call` rows are populated by the
 * `ToolError` taxonomy (`src/tools/errors.ts`); pre-taxonomy rows
 * surface as `error_code: null`. Default window: last 1 hour.
 */
const ToolCallMetricsRowSchema = z
  .object({
    manifest_id: z.string(),
    tool: z.string(),
    transport: z.string(),
    status: z.string(),
    error_code: z.string().nullable(),
    count: z.number().int(),
    avg_duration_ms: z.number().nullable(),
  })
  .openapi('ToolCallMetricsRow');

const HOUR_MS = 60 * 60 * 1000;

const toolCallMetricsRoute = createRoute({
  method: 'get',
  path: '/metrics',
  tags: ['Audit'],
  summary: 'Aggregate tool_call audit events',
  description:
    'Rolls up `tool_call` audit rows by `(manifest_id, tool, transport, status, error_code)` ' +
    'for the time window. Pairs with the Analytics Engine `orchestrator_tool_calls` dataset ' +
    'when long-range slicing is needed.',
  security: BearerSecurity(),
  request: {
    query: z.object({
      since: z.coerce
        .number()
        .int()
        .optional()
        .openapi({ description: 'Lower bound (ms since epoch). Defaults to one hour ago.' }),
      until: z.coerce
        .number()
        .int()
        .optional()
        .openapi({ description: 'Upper bound (ms since epoch). Defaults to now.' }),
      manifest_id: z.string().optional().openapi({ description: 'Filter rows to one manifest.' }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .openapi({ description: 'Max rows (1–500).' }),
    }),
  },
  responses: {
    200: {
      description: 'Tool-call aggregations for the tenant.',
      content: {
        'application/json': {
          schema: z
            .object({
              since: z.number().int(),
              until: z.number().int(),
              rows: z.array(ToolCallMetricsRowSchema),
            })
            .openapi('ToolCallMetricsResponse'),
        },
      },
    },
  },
});

export function buildAuditRouter() {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

  router.openapi(listAuditRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { status, limit } = c.req.valid('query');
    const events = await listEvents(c.env, {
      tenantId: auth.principal.tenantId,
      status,
      limit,
    });
    return c.json({ events }, 200);
  });

  router.openapi(toolCallMetricsRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { since, until, manifest_id, limit } = c.req.valid('query');
    const now = Date.now();
    const sinceMs = since ?? now - HOUR_MS;
    const untilMs = until ?? now;
    const rows = await getToolCallMetrics(c.env, {
      tenantId: auth.principal.tenantId,
      since: sinceMs,
      until: untilMs,
      manifestId: manifest_id,
      limit,
    });
    return c.json({ since: sinceMs, until: untilMs, rows }, 200);
  });

  return router;
}
