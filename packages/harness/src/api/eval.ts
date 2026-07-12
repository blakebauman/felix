/**
 * /eval — golden datasets and replay-driven regression runs.
 *
 * Endpoints:
 *   POST   /eval/datasets                     create a dataset
 *   GET    /eval/datasets                     list datasets
 *   GET    /eval/datasets/{name}              fetch one dataset
 *   POST   /eval/datasets/{name}/items        add an item
 *   GET    /eval/datasets/{name}/items        list items
 *   POST   /eval/datasets/{name}/run          run the dataset
 *   GET    /eval/runs                         list runs (optional ?dataset=)
 *   GET    /eval/runs/{id}                    fetch one run
 *
 * Tenant scoping is enforced at the storage layer; the route only
 * supplies `auth.principal.tenantId` and `principal.subject` to the
 * runner so audit lands the right rows.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AuthContext } from '../auth/context';
import { requireScope } from '../auth/middleware';
import type { Env } from '../env';
import {
  addItem,
  createDataset,
  createRun,
  getDataset,
  getRun,
  listDatasets,
  listItems,
  listRuns,
} from '../eval/datasets';
import { deterministicJudge, workersAiJudge } from '../eval/judge';
import { runDatasetDetached } from '../eval/runner';
import {
  EvalDatasetItemSchema,
  EvalDatasetSchema,
  EvalRunSchema,
  RubricSchema,
} from '../eval/types';
import type { ToolProvider } from '../tools/provider';
import { BearerSecurity, ErrorBodySchema } from './openapi-shared';

const CreateDatasetBody = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'lowercase alphanumeric, underscore, hyphen'),
    description: z.string().default(''),
  })
  .strict()
  .openapi('CreateEvalDatasetRequest');

const AddItemBody = z
  .object({
    item_id: z.string().optional(),
    user_input: z.string().min(1),
    rubric: RubricSchema,
  })
  .strict()
  .openapi('AddEvalItemRequest');

const RunBody = z
  .object({
    candidate_manifest: z.string().min(1),
    /**
     * Pin the candidate to a specific tenant-managed version instead of the
     * active pointer. Use this to eval an inactive version before promoting
     * it — the resulting run records the version so the `/manifests`
     * activation gate can match a passing run to the exact version.
     */
    candidate_version: z
      .number()
      .int()
      .min(1)
      .optional()
      .openapi({ description: 'Tenant-managed version to test (defaults to the active pointer).' }),
    /**
     * When true, the runner uses the deterministic-only judge — substring
     * gates only, no Workers AI call. Useful for CI on a Worker without
     * the AI binding configured.
     */
    deterministic_judge: z.boolean().default(false),
  })
  .strict()
  .openapi('RunEvalRequest');

const RunAcceptedSchema = z
  .object({
    run_id: z.string(),
    /**
     * The run is created non-terminal and executed in the background; poll
     * `GET /eval/runs/{id}` until `status` is `completed` / `failed`.
     */
    status: z.literal('in_progress'),
  })
  .openapi('EvalRunAccepted');

const createDatasetRoute = createRoute({
  method: 'post',
  path: '/datasets',
  tags: ['Eval'],
  summary: 'Create or upsert an eval dataset',
  security: BearerSecurity(),
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateDatasetBody } } },
  },
  responses: {
    201: {
      description: 'Dataset created (or upserted).',
      content: { 'application/json': { schema: EvalDatasetSchema } },
    },
  },
});

const listDatasetsRoute = createRoute({
  method: 'get',
  path: '/datasets',
  tags: ['Eval'],
  summary: 'List eval datasets for the authenticated tenant',
  security: BearerSecurity(),
  responses: {
    200: {
      description: 'Datasets newest first.',
      content: {
        'application/json': {
          schema: z
            .object({ datasets: z.array(EvalDatasetSchema) })
            .openapi('EvalDatasetListResponse'),
        },
      },
    },
  },
});

const getDatasetRoute = createRoute({
  method: 'get',
  path: '/datasets/{name}',
  tags: ['Eval'],
  summary: 'Fetch a single eval dataset',
  security: BearerSecurity(),
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: {
      description: 'Dataset record.',
      content: { 'application/json': { schema: EvalDatasetSchema } },
    },
    404: {
      description: 'No dataset by that name for the caller’s tenant.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const addItemRoute = createRoute({
  method: 'post',
  path: '/datasets/{name}/items',
  tags: ['Eval'],
  summary: 'Add (or upsert) an item to an eval dataset',
  security: BearerSecurity(),
  request: {
    params: z.object({ name: z.string() }),
    body: { required: true, content: { 'application/json': { schema: AddItemBody } } },
  },
  responses: {
    201: {
      description: 'Item stored.',
      content: { 'application/json': { schema: EvalDatasetItemSchema } },
    },
    404: {
      description: 'Dataset does not exist for this tenant.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const listItemsRoute = createRoute({
  method: 'get',
  path: '/datasets/{name}/items',
  tags: ['Eval'],
  summary: 'List items in an eval dataset',
  security: BearerSecurity(),
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: {
      description: 'Items ordered by creation time.',
      content: {
        'application/json': {
          schema: z
            .object({ items: z.array(EvalDatasetItemSchema) })
            .openapi('EvalItemListResponse'),
        },
      },
    },
  },
});

const runDatasetRoute = createRoute({
  method: 'post',
  path: '/datasets/{name}/run',
  tags: ['Eval'],
  summary: 'Execute an eval dataset against a candidate manifest',
  description:
    'Creates a run and executes it in the background: iterates the dataset items, invokes the ' +
    'candidate manifest on each, and judges the response against the item rubric. Returns ' +
    '`202 { run_id, status: "in_progress" }` immediately so large datasets do not hit the ' +
    'Worker CPU / subrequest ceiling. Poll `GET /eval/runs/{id}` for the terminal status ' +
    '(`completed` / `failed`), aggregate pass/fail counts, and per-item scores. A candidate ' +
    'manifest that cannot be resolved surfaces as a `failed` run, not a 4xx on this call.',
  security: BearerSecurity(),
  request: {
    params: z.object({ name: z.string() }),
    body: { required: true, content: { 'application/json': { schema: RunBody } } },
  },
  responses: {
    202: {
      description: 'Run accepted and executing in the background.',
      content: { 'application/json': { schema: RunAcceptedSchema } },
    },
    404: {
      description: 'Dataset not found for this tenant.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const listRunsRoute = createRoute({
  method: 'get',
  path: '/runs',
  tags: ['Eval'],
  summary: 'List eval runs for the authenticated tenant',
  security: BearerSecurity(),
  request: {
    query: z.object({
      dataset: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: {
      description: 'Runs newest first.',
      content: {
        'application/json': {
          schema: z.object({ runs: z.array(EvalRunSchema) }).openapi('EvalRunListResponse'),
        },
      },
    },
  },
});

const getRunRoute = createRoute({
  method: 'get',
  path: '/runs/{id}',
  tags: ['Eval'],
  summary: 'Fetch one eval run (with per-item scores)',
  security: BearerSecurity(),
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Run record.',
      content: { 'application/json': { schema: EvalRunSchema } },
    },
    404: {
      description: 'No run by that id for the caller’s tenant.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

export interface EvalRouterDeps {
  tools: ToolProvider;
}

const READ_SCOPE = 'eval:read';
const WRITE_SCOPE = 'eval:write';

export function buildEvalRouter(deps: EvalRouterDeps) {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

  router.openapi(createDatasetRoute, async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const dataset = await createDataset(
      c.env,
      auth.principal.tenantId,
      body.name,
      body.description,
    );
    return c.json(dataset, 201);
  });

  router.openapi(listDatasetsRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const datasets = await listDatasets(c.env, auth.principal.tenantId);
    return c.json({ datasets }, 200);
  });

  router.openapi(getDatasetRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { name } = c.req.valid('param');
    const ds = await getDataset(c.env, auth.principal.tenantId, name);
    if (!ds) return c.json({ error: 'not found' }, 404);
    return c.json(ds, 200);
  });

  router.openapi(addItemRoute, async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { name } = c.req.valid('param');
    const ds = await getDataset(c.env, auth.principal.tenantId, name);
    if (!ds) return c.json({ error: 'not found' }, 404);
    const body = c.req.valid('json');
    const item = await addItem(c.env, auth.principal.tenantId, name, {
      itemId: body.item_id,
      userInput: body.user_input,
      rubric: body.rubric,
    });
    return c.json(item, 201);
  });

  router.openapi(listItemsRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { name } = c.req.valid('param');
    const items = await listItems(c.env, auth.principal.tenantId, name);
    return c.json({ items }, 200);
  });

  router.openapi(runDatasetRoute, async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { name } = c.req.valid('param');
    const body = c.req.valid('json');
    const ds = await getDataset(c.env, auth.principal.tenantId, name);
    if (!ds) return c.json({ error: 'not found' }, 404);
    const run = await createRun(c.env, auth.principal.tenantId, {
      datasetName: name,
      candidateManifest: body.candidate_manifest,
    });
    const judge = body.deterministic_judge ? deterministicJudge() : workersAiJudge(c.env);
    // Execute off the request path. The run row is already `in_progress`;
    // `runDatasetDetached` installs its own tenant-scoped context, drives
    // the dataset, and finalizes the row (`completed` / `failed`) when it
    // settles. `waitUntil` keeps the isolate alive until the background
    // job completes without blocking the 202 response.
    c.executionCtx.waitUntil(
      runDatasetDetached(
        c.env,
        deps.tools,
        {
          tenantId: auth.principal.tenantId,
          principalSubject: auth.principal.subject,
          runId: run.id,
          datasetName: name,
          candidateManifest: body.candidate_manifest,
          candidateVersion: body.candidate_version,
          judge,
        },
        c.executionCtx,
      ),
    );
    return c.json({ run_id: run.id, status: 'in_progress' as const }, 202);
  });

  router.openapi(listRunsRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { dataset, limit } = c.req.valid('query');
    const runs = await listRuns(c.env, auth.principal.tenantId, {
      datasetName: dataset,
      limit,
    });
    return c.json({ runs }, 200);
  });

  router.openapi(getRunRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const run = await getRun(c.env, auth.principal.tenantId, id);
    if (!run) return c.json({ error: 'not found' }, 404);
    return c.json(run, 200);
  });

  return router;
}
