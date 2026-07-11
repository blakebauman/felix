/**
 * Tenant-managed manifest CRUD.
 *
 *   GET    /manifests                              → active versions for tenant
 *   GET    /manifests/:name                        → resolved manifest (tenant → R2 → bundled)
 *   GET    /manifests/:name/versions               → version log (tenant-private)
 *   GET    /manifests/:name/versions/:version      → specific tenant version blob
 *   POST   /manifests/:name                        → create new version (activate by default)
 *   POST   /manifests/:name/activate               → flip pointer (rollback)
 *   DELETE /manifests/:name                        → drop all tenant rows
 *   DELETE /manifests/:name/versions/:version      → drop one version row
 *
 * Reads require the `manifests:read` scope and writes `manifests:write`
 * (see auth/middleware `requireScope`); all queries are tenant-scoped
 * through `auth.principal.tenantId` (matching `/jobs`, `/plans`,
 * `/approvals`). In `ENVIRONMENT=development` without verifiers
 * configured, the scope gate falls open so local probes and integration
 * tests work without minting tokens.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { recordEvent } from '../audit/store';
import type { AuthContext } from '../auth/context';
import { requireScope } from '../auth/middleware';
import type { Env } from '../env';
import { invalidateActive, resolveManifest } from '../manifests/resolver';
import { MANIFEST_NAME_RE, ManifestSchema } from '../manifests/schema';
import {
  activateVersion,
  clearCanary,
  createVersion,
  deleteName,
  deleteVersion,
  getActive,
  getVersion,
  listActive,
  listVersions,
  setCanary,
} from '../manifests/store';
import { ManifestValidationError, validateManifest } from '../manifests/validate';
import { BearerSecurity, ErrorBodySchema, PaginatedQuery } from './openapi-shared';

const MAX_COMMENT_LEN = 500;
const WRITE_SCOPE = 'manifests:write';
const READ_SCOPE = 'manifests:read';

const NameParam = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(MANIFEST_NAME_RE)
    .openapi({ description: 'Manifest name (matches `metadata.name`).', example: 'shopping' }),
});

const VersionParam = NameParam.extend({
  version: z.coerce
    .number()
    .int()
    .min(1)
    .openapi({ description: 'Manifest version (positive integer).', example: 2 }),
});

const ManifestCreateRequestSchema = z
  .object({
    manifest: ManifestSchema,
    comment: z
      .string()
      .max(MAX_COMMENT_LEN)
      .optional()
      .openapi({ description: `Optional change comment (≤${MAX_COMMENT_LEN} chars).` }),
  })
  .strict()
  .openapi('ManifestCreateRequest');

const ManifestActivateRequestSchema = z
  .object({ version: z.number().int().min(1) })
  .strict()
  .openapi('ManifestActivateRequest', { example: { version: 2 } });

const ManifestSummarySchema = z
  .object({
    name: z.string(),
    active_version: z.number().int().nullable(),
    updated_at: z.number().int().optional(),
    updated_by: z.string().optional(),
  })
  .passthrough()
  .openapi('ManifestSummary');

const ResolvedManifestResponseSchema = z
  .object({
    name: z.string(),
    source: z.enum(['tenant_d1', 'tenant_r2', 'global_r2', 'bundled']),
    version: z.number().int().nullable(),
    manifest: ManifestSchema,
  })
  .openapi('ResolvedManifestResponse');

const ManifestVersionSummarySchema = z
  .object({
    version: z.number().int(),
    created_at: z.number().int(),
    created_by: z.string(),
    comment: z.string(),
    active: z.boolean(),
  })
  .openapi('ManifestVersionSummary');

const ManifestVersionListSchema = z
  .object({
    name: z.string(),
    active_version: z.number().int().nullable(),
    versions: z.array(ManifestVersionSummarySchema),
  })
  .openapi('ManifestVersionList');

const ManifestVersionDetailSchema = z
  .object({
    name: z.string(),
    version: z.number().int(),
    created_at: z.number().int(),
    created_by: z.string(),
    comment: z.string(),
    manifest: ManifestSchema,
  })
  .openapi('ManifestVersionDetail');

const ManifestCreateResponseSchema = z
  .object({
    name: z.string(),
    version: z.number().int(),
    created_at: z.number().int(),
    created_by: z.string(),
    comment: z.string(),
    activated: z.boolean(),
  })
  .openapi('ManifestCreateResponse');

const ManifestActivateResponseSchema = z
  .object({
    name: z.string(),
    active_version: z.number().int(),
    updated_at: z.number().int(),
  })
  .openapi('ManifestActivateResponse');

const ManifestCanaryRequestSchema = z
  .object({
    canary_version: z
      .number()
      .int()
      .min(1)
      .nullable()
      .openapi({
        description:
          'Version to route canary traffic to. Must already exist in the tenant version log. ' +
          'Pass `null` to clear the canary pointer (equivalent to `POST /rollback` with `clear_version: true`).',
      }),
    canary_weight: z
      .number()
      .int()
      .min(0)
      .max(100)
      .openapi({
        description:
          'Percent of traffic routed to the canary (0–100). Bucketed deterministically per ' +
          'thread so a single conversation stays on one side across the rollout.',
      }),
  })
  .strict()
  .openapi('ManifestCanaryRequest', { example: { canary_version: 3, canary_weight: 25 } });

const ManifestCanaryResponseSchema = z
  .object({
    name: z.string(),
    active_version: z.number().int(),
    canary_version: z.number().int().nullable(),
    canary_weight: z.number().int(),
    updated_at: z.number().int(),
  })
  .openapi('ManifestCanaryResponse');

const ManifestRollbackRequestSchema = z
  .object({
    clear_version: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'When true, also clears the `canary_version` pointer (next `POST /canary` must ' +
          're-supply a version). Default is to only zero `canary_weight` so the version stays ' +
          'pinned for a follow-up retry once the underlying issue is fixed.',
      }),
  })
  .strict()
  .openapi('ManifestRollbackRequest');

const listManifestsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Manifests'],
  summary: 'List active manifests for the authenticated tenant',
  security: BearerSecurity(),
  request: { query: PaginatedQuery },
  responses: {
    200: {
      description: 'Active tenant-managed manifests.',
      content: {
        'application/json': {
          schema: z
            .object({ manifests: z.array(ManifestSummarySchema) })
            .openapi('ManifestListResponse'),
        },
      },
    },
  },
});

const getManifestRoute = createRoute({
  method: 'get',
  path: '/{name}',
  tags: ['Manifests'],
  summary: 'Resolve a manifest through the 4-layer chain',
  description:
    'Walks tenant D1 → tenant R2 → global R2 → bundled. `?version=` pins a specific ' +
    'tenant-managed version (D1 only).',
  security: BearerSecurity(),
  request: {
    params: NameParam,
    query: z.object({
      version: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .openapi({ description: 'Pin to a specific tenant-managed version.' }),
    }),
  },
  responses: {
    200: {
      description: 'Resolved manifest plus the layer it came from.',
      content: { 'application/json': { schema: ResolvedManifestResponseSchema } },
    },
    400: {
      description: 'Bad `version` query param.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    404: {
      description: 'Unknown manifest at every resolver layer.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const listVersionsRoute = createRoute({
  method: 'get',
  path: '/{name}/versions',
  tags: ['Manifests'],
  summary: 'List versions of a tenant-managed manifest',
  security: BearerSecurity(),
  request: { params: NameParam, query: PaginatedQuery },
  responses: {
    200: {
      description: 'Version log, newest first.',
      content: { 'application/json': { schema: ManifestVersionListSchema } },
    },
  },
});

const getVersionRoute = createRoute({
  method: 'get',
  path: '/{name}/versions/{version}',
  tags: ['Manifests'],
  summary: 'Fetch a specific version blob',
  security: BearerSecurity(),
  request: { params: VersionParam },
  responses: {
    200: {
      description: 'Version detail.',
      content: { 'application/json': { schema: ManifestVersionDetailSchema } },
    },
    400: {
      description: 'Bad version path param.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    404: {
      description: 'Unknown version.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const createManifestRoute = createRoute({
  method: 'post',
  path: '/{name}',
  tags: ['Manifests'],
  summary: 'Append a new manifest version (activate by default)',
  description:
    'Requires the `manifests:write` scope on the caller’s JWT. Pass `?activate=false` ' +
    'to upload without flipping the active pointer.',
  security: BearerSecurity(),
  request: {
    params: NameParam,
    query: z.object({
      activate: z
        .enum(['true', 'false'])
        .optional()
        .openapi({ description: 'When `false`, the upload does not become active.' }),
    }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: ManifestCreateRequestSchema,
          examples: {
            minimalReact: {
              summary: 'Minimal anonymous react agent',
              value: {
                manifest: {
                  apiVersion: 'orchestrator/v1',
                  kind: 'Agent',
                  metadata: { name: 'quick' },
                  spec: {
                    pattern: 'react',
                    model: { id: 'claude-sonnet-4' },
                    system_prompt: {
                      inline: 'You are a friendly assistant. Use the calculator for arithmetic.',
                    },
                    tools: ['calculator'],
                    auth: { inbound: { allow_anonymous: true } },
                  },
                },
                comment: 'initial',
              },
            },
            withGovernance: {
              summary: 'Hardened deep agent with limits, policies, and HITL approvals',
              value: {
                manifest: {
                  apiVersion: 'orchestrator/v1',
                  kind: 'Agent',
                  metadata: { name: 'research', version: '2.1.0' },
                  spec: {
                    pattern: 'deep',
                    model: { id: 'claude-opus-4', temperature: 0, max_tokens: 4096 },
                    system_prompt: {
                      inline:
                        'You are an internal research analyst. Plan with plan_create before invoking any tool.',
                    },
                    tools: ['calculator'],
                    auth: {
                      inbound: { allow_anonymous: false, required_scopes: ['research:read'] },
                    },
                    limits: {
                      max_tool_calls: 40,
                      max_wall_clock_seconds: 120,
                      max_peer_hops: 2,
                    },
                    policies: [
                      {
                        id: 'write-paths',
                        required_scopes: ['research:write'],
                        tools: ['notion__create_page'],
                      },
                    ],
                    approvals: [
                      {
                        id: 'external-publication',
                        description: 'Any write to Notion requires reviewer signoff.',
                        tools: ['notion__create_page', 'notion__update_page'],
                      },
                    ],
                    guardrails: {
                      providers: ['pii'],
                      block_on_match: false,
                      targets: ['input', 'output'],
                    },
                  },
                },
                comment: 'add HITL approvals on writes',
              },
            },
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Version created.',
      content: { 'application/json': { schema: ManifestCreateResponseSchema } },
    },
    400: {
      description: 'Validation failure (Zod, cross-field, or `name_mismatch`).',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const activateManifestRoute = createRoute({
  method: 'post',
  path: '/{name}/activate',
  tags: ['Manifests'],
  summary: 'Flip the active pointer to a specific version (rollback)',
  description: 'Requires the `manifests:write` scope.',
  security: BearerSecurity(),
  request: {
    params: NameParam,
    body: {
      required: true,
      content: { 'application/json': { schema: ManifestActivateRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Active pointer updated.',
      content: { 'application/json': { schema: ManifestActivateResponseSchema } },
    },
    400: {
      description: 'Bad version.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    404: {
      description: 'Unknown version.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const setCanaryRoute = createRoute({
  method: 'post',
  path: '/{name}/canary',
  tags: ['Manifests'],
  summary: 'Set or update the canary pointer on the active manifest',
  description:
    'Requires the `manifests:write` scope. The active stable version is unchanged — ' +
    'the resolver hashes `(tenant, thread, name, stable_v, canary_v)` to bucket each ' +
    'thread; flipping `canary_version` or `canary_weight` re-randomises the bucket.',
  security: BearerSecurity(),
  request: {
    params: NameParam,
    body: {
      required: true,
      content: { 'application/json': { schema: ManifestCanaryRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Canary pointer updated.',
      content: { 'application/json': { schema: ManifestCanaryResponseSchema } },
    },
    404: {
      description: 'No active stable version, or canary version not found.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const rollbackManifestRoute = createRoute({
  method: 'post',
  path: '/{name}/rollback',
  tags: ['Manifests'],
  summary: 'Atomically zero the canary weight (manual rollback)',
  description:
    'Requires the `manifests:write` scope. Counterpart to the anomaly cron auto-rollback ' +
    'path — both call into the same `clearCanary` primitive and emit `manifest_canary_cleared` audit events.',
  security: BearerSecurity(),
  request: {
    params: NameParam,
    body: {
      required: true,
      content: { 'application/json': { schema: ManifestRollbackRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Canary weight zeroed.',
      content: { 'application/json': { schema: ManifestCanaryResponseSchema } },
    },
    404: {
      description: 'No active manifest for this tenant.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const deleteManifestRoute = createRoute({
  method: 'delete',
  path: '/{name}',
  tags: ['Manifests'],
  summary: 'Wipe every tenant version of a manifest',
  description:
    'Requires the `manifests:write` scope. Lower layers (global R2, bundled) are ' +
    'unaffected and will resolve again on subsequent reads.',
  security: BearerSecurity(),
  request: { params: NameParam },
  responses: {
    200: {
      description: 'Manifest wiped from tenant storage.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    404: {
      description: 'No tenant rows existed.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

const deleteVersionRoute = createRoute({
  method: 'delete',
  path: '/{name}/versions/{version}',
  tags: ['Manifests'],
  summary: 'Delete a single inactive manifest version',
  description: 'Requires the `manifests:write` scope. The active version cannot be deleted.',
  security: BearerSecurity(),
  request: { params: VersionParam },
  responses: {
    200: {
      description: 'Version deleted.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    400: {
      description: 'Bad version path param.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    404: {
      description: 'Unknown version.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    409: {
      description: 'Cannot delete the active version; activate another version first.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

export function buildManifestsRouter() {
  // The default zod-openapi error envelope (`{ success: false, error: ZodError }`)
  // differs from this router's documented `{ error, detail }` shape, and the
  // CRUD integration tests assert specific error codes (`validation_failed`,
  // `name_mismatch`). The hook converts validation failures to the documented
  // shape so the spec is honest and tests stay green.
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          { error: 'validation_failed', detail: result.error.message.slice(0, 1000) },
          400,
        );
      }
    },
  });

  router.openapi(listManifestsRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { limit } = c.req.valid('query');
    const active = await listActive(c.env, auth.principal.tenantId, limit);
    return c.json({ manifests: active }, 200);
  });

  router.openapi(getManifestRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { name } = c.req.valid('param');
    const { version: pinVersion } = c.req.valid('query');
    try {
      const resolved = await resolveManifest(c.env, auth.principal.tenantId, name, { pinVersion });
      return c.json(
        {
          name,
          source: resolved.source,
          version: resolved.version ?? null,
          manifest: resolved.manifest,
        },
        200,
      );
    } catch (err) {
      return c.json({ error: 'not_found', detail: (err as Error).message }, 404);
    }
  });

  router.openapi(listVersionsRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { name } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    const versions = await listVersions(c.env, auth.principal.tenantId, name, limit);
    const active = await getActive(c.env, auth.principal.tenantId, name);
    return c.json(
      {
        name,
        active_version: active?.version ?? null,
        versions: versions.map((v) => ({
          version: v.version,
          created_at: v.created_at,
          created_by: v.created_by,
          comment: v.comment,
          active: v.version === active?.version,
        })),
      },
      200,
    );
  });

  router.openapi(getVersionRoute, async (c) => {
    const denied = requireScope(c, READ_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { name, version } = c.req.valid('param');
    const row = await getVersion(c.env, auth.principal.tenantId, name, version);
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json(
      {
        name: row.name,
        version: row.version,
        created_at: row.created_at,
        created_by: row.created_by,
        comment: row.comment,
        manifest: row.manifest,
      },
      200,
    );
  });

  router.openapi(createManifestRoute, async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');

    const { name } = c.req.valid('param');
    const { activate: activateParam } = c.req.valid('query');
    const body = c.req.valid('json');
    const parsed = body.manifest;

    if (parsed.metadata.name !== name) {
      return c.json(
        {
          error: 'name_mismatch',
          detail: `URL name '${name}' does not match metadata.name '${parsed.metadata.name}'`,
        },
        400,
      );
    }
    try {
      validateManifest(parsed);
    } catch (err) {
      if (err instanceof ManifestValidationError) {
        return c.json({ error: 'validation_failed', detail: err.message }, 400);
      }
      throw err;
    }

    const activate = activateParam !== 'false';
    const created = await createVersion(c.env, {
      tenantId: auth.principal.tenantId,
      name,
      manifest: parsed,
      createdBy: auth.principal.subject,
      comment: body.comment ?? '',
      activate,
    });
    if (activate) invalidateActive(auth.principal.tenantId, name);

    recordEvent({
      tenantId: auth.principal.tenantId,
      eventType: 'manifest_created',
      principalSubject: auth.principal.subject,
      manifestId: name,
      status: String(created.version),
      payload: { version: created.version, comment: created.comment, activated: activate },
    });

    return c.json(
      {
        name,
        version: created.version,
        created_at: created.created_at,
        created_by: created.created_by,
        comment: created.comment,
        activated: activate,
      },
      201,
    );
  });

  router.openapi(activateManifestRoute, async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');

    const { name } = c.req.valid('param');
    const body = c.req.valid('json');

    const updated = await activateVersion(c.env, {
      tenantId: auth.principal.tenantId,
      name,
      version: body.version,
      updatedBy: auth.principal.subject,
    });
    if (!updated) return c.json({ error: 'not_found', detail: 'unknown version' }, 404);
    invalidateActive(auth.principal.tenantId, name);

    recordEvent({
      tenantId: auth.principal.tenantId,
      eventType: 'manifest_activated',
      principalSubject: auth.principal.subject,
      manifestId: name,
      status: String(body.version),
      payload: { version: body.version },
    });

    return c.json({ name, active_version: updated.version, updated_at: updated.updated_at }, 200);
  });

  router.openapi(setCanaryRoute, async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { name } = c.req.valid('param');
    const body = c.req.valid('json');
    let updated: Awaited<ReturnType<typeof setCanary>>;
    try {
      updated = await setCanary(c.env, {
        tenantId: auth.principal.tenantId,
        name,
        canaryVersion: body.canary_version,
        canaryWeight: body.canary_weight,
        updatedBy: auth.principal.subject,
      });
    } catch (err) {
      return c.json({ error: 'unknown_canary_version', detail: (err as Error).message }, 404);
    }
    if (!updated) {
      return c.json(
        {
          error: 'not_found',
          detail: 'no active stable version — POST /manifests/:name to create one first',
        },
        404,
      );
    }
    invalidateActive(auth.principal.tenantId, name);
    recordEvent({
      tenantId: auth.principal.tenantId,
      eventType: 'manifest_canary_set',
      principalSubject: auth.principal.subject,
      manifestId: name,
      status: String(updated.canary_weight),
      payload: {
        canary_version: updated.canary_version,
        canary_weight: updated.canary_weight,
        stable_version: updated.version,
      },
    });
    return c.json(
      {
        name,
        active_version: updated.version,
        canary_version: updated.canary_version,
        canary_weight: updated.canary_weight,
        updated_at: updated.updated_at,
      },
      200,
    );
  });

  router.openapi(rollbackManifestRoute, async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');
    const { name } = c.req.valid('param');
    const { clear_version } = c.req.valid('json');
    const updated = await clearCanary(c.env, {
      tenantId: auth.principal.tenantId,
      name,
      clearVersion: clear_version,
      updatedBy: auth.principal.subject,
    });
    if (!updated) return c.json({ error: 'not_found' }, 404);
    invalidateActive(auth.principal.tenantId, name);
    recordEvent({
      tenantId: auth.principal.tenantId,
      eventType: 'manifest_canary_cleared',
      principalSubject: auth.principal.subject,
      manifestId: name,
      status: 'manual',
      payload: {
        canary_version: updated.canary_version,
        canary_weight: updated.canary_weight,
        stable_version: updated.version,
        clear_version,
      },
    });
    return c.json(
      {
        name,
        active_version: updated.version,
        canary_version: updated.canary_version,
        canary_weight: updated.canary_weight,
        updated_at: updated.updated_at,
      },
      200,
    );
  });

  router.openapi(deleteManifestRoute, async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');

    const { name } = c.req.valid('param');
    const removed = await deleteName(c.env, auth.principal.tenantId, name);
    if (!removed) return c.json({ error: 'not_found' }, 404);
    invalidateActive(auth.principal.tenantId, name);

    recordEvent({
      tenantId: auth.principal.tenantId,
      eventType: 'manifest_deleted',
      principalSubject: auth.principal.subject,
      manifestId: name,
      payload: { scope: 'all_versions' },
    });

    return c.json({ ok: true as const }, 200);
  });

  router.openapi(deleteVersionRoute, async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied as never;
    const auth = c.get('auth');

    const { name, version } = c.req.valid('param');

    const result = await deleteVersion(c.env, auth.principal.tenantId, name, version);
    if (result.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (result.status === 'active') {
      return c.json(
        {
          error: 'conflict',
          detail: 'cannot delete the active version; activate another version first',
        },
        409,
      );
    }

    recordEvent({
      tenantId: auth.principal.tenantId,
      eventType: 'manifest_deleted',
      principalSubject: auth.principal.subject,
      manifestId: name,
      status: String(version),
      payload: { scope: 'single_version', version },
    });

    return c.json({ ok: true as const }, 200);
  });

  return router;
}
