/**
 * /plans — list / fetch plan artifacts.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AuthContext } from '../auth/context';
import { requireScope } from '../auth/middleware';
import type { Env } from '../env';
import { PlanSchema } from '../plans/models';
import { getPlan, listPlans } from '../plans/store';
import { BearerSecurity, ErrorBodySchema, PaginatedQuery } from './openapi-shared';

const READ_SCOPE = 'plans:read';

const listPlansRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Plans'],
  summary: 'List persisted plans for the authenticated tenant',
  security: BearerSecurity(),
  request: { query: PaginatedQuery },
  responses: {
    200: {
      description: 'Plans, newest first.',
      content: {
        'application/json': {
          schema: z.object({ plans: z.array(PlanSchema) }).openapi('PlanListResponse'),
        },
      },
    },
  },
});

const getPlanRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Plans'],
  summary: 'Fetch a single plan',
  security: BearerSecurity(),
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Plan record.',
      content: { 'application/json': { schema: PlanSchema } },
    },
    404: {
      description: 'No plan with that id for the caller’s tenant.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

export function buildPlansRouter() {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

  router.openapi(listPlansRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { limit } = c.req.valid('query');
    const plans = await listPlans(c.env, auth.principal.tenantId, limit);
    return c.json({ plans }, 200);
  });

  router.openapi(getPlanRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const plan = await getPlan(c.env, auth.principal.tenantId, id);
    if (!plan) return c.json({ error: 'not found' }, 404);
    return c.json(plan, 200);
  });

  return router;
}
