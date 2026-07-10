/**
 * /jobs — persistent job registry + manual triggers.
 *
 * Every endpoint is scoped to the authenticated tenant. The cron sweep
 * (jobs/cron.ts) runs jobs under their owning tenant's identity. Reads require
 * `jobs:read`; create/trigger require `jobs:write`. In production (verifiers
 * configured) an anonymous caller is rejected; `requireScope`'s dev
 * fallthrough keeps local/test probes working when no verifiers are set.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { recordEvent } from '../audit/store';
import type { AuthContext } from '../auth/context';
import { requireScope } from '../auth/middleware';
import type { Env } from '../env';
import { nextRunAfter } from '../jobs/cron';
import { JobRecordSchema } from '../jobs/models';
import { getJob, listJobs, recordRun, upsertJob } from '../jobs/store';
import { BearerSecurity, ErrorBodySchema } from './openapi-shared';

const READ_SCOPE = 'jobs:read';
const WRITE_SCOPE = 'jobs:write';

const JobCreateRequestSchema = JobRecordSchema.pick({
  name: true,
  schedule: true,
  manifest_id: true,
  payload: true,
})
  .strict()
  .openapi('JobCreateRequest', {
    example: { name: 'nightly-digest', schedule: '0 9 * * *', manifest_id: 'quick' },
  });

const listJobsRoute = createRoute({
  method: 'get',
  path: '/list',
  tags: ['Jobs'],
  summary: 'List jobs for the authenticated tenant',
  security: BearerSecurity(),
  responses: {
    200: {
      description: 'Tenant job registry.',
      content: {
        'application/json': {
          schema: z.object({ jobs: z.array(JobRecordSchema) }).openapi('JobListResponse'),
        },
      },
    },
  },
});

const getJobRoute = createRoute({
  method: 'get',
  path: '/{name}',
  tags: ['Jobs'],
  summary: 'Fetch a single job by name',
  security: BearerSecurity(),
  request: { params: z.object({ name: z.string().min(1).max(128) }) },
  responses: {
    200: {
      description: 'Job record.',
      content: { 'application/json': { schema: JobRecordSchema } },
    },
    404: {
      description: 'No job with that name for the caller’s tenant.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const createJobRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Jobs'],
  summary: 'Upsert a job',
  description:
    'Creates or replaces a job. `tenant_id` is always overwritten from the authenticated ' +
    'principal — callers cannot impersonate another tenant.',
  security: BearerSecurity(),
  request: {
    body: { required: true, content: { 'application/json': { schema: JobCreateRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Job created or replaced.',
      content: { 'application/json': { schema: JobRecordSchema } },
    },
  },
});

const runJobRoute = createRoute({
  method: 'post',
  path: '/run/{name}',
  tags: ['Jobs'],
  summary: 'Trigger a job run manually',
  security: BearerSecurity(),
  request: { params: z.object({ name: z.string().min(1).max(128) }) },
  responses: {
    200: {
      description: 'Run recorded.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    404: {
      description: 'No job with that name for the caller’s tenant.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

export function buildJobsRouter() {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

  router.openapi(listJobsRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    return c.json({ jobs: await listJobs(c.env, auth.principal.tenantId) }, 200);
  });

  router.openapi(getJobRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { name } = c.req.valid('param');
    const job = await getJob(c.env, auth.principal.tenantId, name);
    if (!job) return c.json({ error: 'not found' }, 404);
    return c.json(job, 200);
  });

  router.openapi(createJobRoute, async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const raw = c.req.valid('json');
    const now = Date.now();
    const job = JobRecordSchema.parse({
      created_at: now,
      ...raw,
      tenant_id: auth.principal.tenantId,
      next_run_at: raw.schedule ? nextRunAfter(raw.schedule, new Date(now)) : null,
    });
    await upsertJob(c.env, job);
    return c.json(job, 201);
  });

  router.openapi(runJobRoute, async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { name } = c.req.valid('param');
    const job = await getJob(c.env, auth.principal.tenantId, name);
    if (!job) return c.json({ error: 'not found' }, 404);
    await recordRun(c.env, auth.principal.tenantId, name, {
      last_run_at: Date.now(),
      last_status: 'manual',
      last_error: '',
      next_run_at: job.schedule ? nextRunAfter(job.schedule, new Date()) : null,
    });
    recordEvent({
      tenantId: auth.principal.tenantId,
      eventType: 'job_run',
      principalSubject: auth.principal.subject,
      manifestId: job.manifest_id,
      status: 'manual',
      payload: { job: name },
    });
    return c.json({ ok: true as const }, 200);
  });

  return router;
}
