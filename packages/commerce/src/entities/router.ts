/**
 * Entity data-source administration.
 *
 *   GET  /entities/types              → registered entity types
 *   GET  /entities/:type/source       → this tenant's data-source config
 *   PUT  /entities/:type/source       → set native/federated/synced + connector
 *   POST /entities/:type/sync         → pull from the connector into D1 (synced)
 *   POST /entities/:type/push         → 3p webhook: upsert pushed records (synced)
 *
 * Config + sync are operator actions, gated by the `entities:write` scope (dev
 * falls open). Push is a trusted 3p → us call authenticated by the consumer
 * shared secret (no JWT), like `/internal`; the tenant is taken from the body.
 */

import type { AuthContext } from '@felix/orchestrator/auth/context';
import { requireScope } from '@felix/orchestrator/auth/middleware';
import type { Env } from '@felix/orchestrator/env';
import { constantTimeEqual } from '@felix/orchestrator/security/constant-time';
import { Hono } from 'hono';
import { z } from 'zod';
import { getDataSourceConfig, setDataSourceConfig } from './config-store';
import { listEntityTypes } from './registry';
import { pullSync, pushImport } from './sync';

const WRITE_SCOPE = 'entities:write';

const ConnectorConfigSchema = z
  .object({
    kind: z.string().min(1),
    url: z.string().url(),
    auth: z.string().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    cache_ttl_seconds: z.number().int().nonnegative().optional(),
  })
  .strict();

const DataSourceConfigSchema = z
  .object({
    mode: z.enum(['native', 'federated', 'synced']),
    connector: ConnectorConfigSchema.optional(),
  })
  .strict()
  .refine((c) => c.mode === 'native' || !!c.connector, {
    message: 'federated/synced modes require a connector config',
  });

const PushSchema = z
  .object({
    tenant_id: z.string().min(1),
    records: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
  })
  .strict();

type Vars = { Variables: { auth: AuthContext } };

export function buildEntitiesRouter(): Hono<{ Bindings: Env } & Vars> {
  const app = new Hono<{ Bindings: Env } & Vars>();

  app.get('/types', (c) => c.json({ types: listEntityTypes() }, 200));

  app.get('/:type/source', async (c) => {
    const tenant = c.get('auth').principal.tenantId;
    return c.json(await getDataSourceConfig(c.env, tenant, c.req.param('type')), 200);
  });

  app.put('/:type/source', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const parsed = DataSourceConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
    const tenant = c.get('auth').principal.tenantId;
    await setDataSourceConfig(
      c.env,
      tenant,
      c.req.param('type'),
      parsed.data,
      c.get('auth').principal.subject,
    );
    return c.json({ ok: true }, 200);
  });

  app.post('/:type/sync', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const tenant = c.get('auth').principal.tenantId;
    try {
      const result = await pullSync(c.env, tenant, c.req.param('type'));
      return c.json(result, 200);
    } catch (err) {
      return c.json({ error: 'sync_failed', detail: (err as Error).message }, 502);
    }
  });

  app.post('/:type/push', async (c) => {
    const secret = c.env.CONSUMER_SHARED_SECRET;
    if (!secret) return c.json({ error: 'push not configured' }, 503);
    if (!(await constantTimeEqual(c.req.header('x-consumer-secret') ?? '', secret))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const parsed = PushSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
    try {
      const result = await pushImport(
        c.env,
        parsed.data.tenant_id,
        c.req.param('type'),
        parsed.data.records,
      );
      return c.json(result, 200);
    } catch (err) {
      return c.json({ error: 'push_failed', detail: (err as Error).message }, 400);
    }
  });

  return app;
}
