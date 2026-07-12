/**
 * Internal routes for trusted infrastructure callers (queue consumers,
 * peer Workers running this same harness, scheduled jobs in adjacent
 * deployments). Authn is a shared secret in the `x-consumer-secret`
 * header, compared in constant time against `env.CONSUMER_SHARED_SECRET`.
 *
 * The only route today is the queue-consumer write-back path:
 *
 *   POST /internal/sessions/:thread_id/events
 *     { events: [{ kind: 'tool_result', tool_call_id, name, content, metadata? }] }
 *
 * The route is intentionally narrow:
 *   - `kind` MUST be `'tool_result'` (no arbitrary writes).
 *   - The shared secret is the only authn — there is no JWT path here.
 *   - The tenant_id is parsed from the thread_id prefix (`tenant:suffix`).
 *     A malformed thread_id is rejected.
 *   - **Dispatch pairing.** The shared secret is fleet-global, so it alone
 *     would let any holder inject an arbitrary `tool_result` into ANY
 *     tenant's thread. Before writing, each event's `tool_call_id` is
 *     matched against an outstanding `queue_dispatch` audit row for THIS
 *     tenant whose recorded `thread_id` equals the addressed thread. A
 *     write-back with no matching dispatch — a forged / cross-tenant id —
 *     is rejected (409) and nothing is written.
 *   - **One-shot.** A dispatch that already has a `queue_complete` /
 *     `queue_expired` row is settled; a second write-back for the same
 *     `tool_call_id` is a replay and is rejected (409). On success a
 *     `queue_complete` audit row is emitted server-side (carrying the
 *     dispatch's manifest id) so consumers don't need to emit it and a
 *     misbehaving consumer can't skip the audit trail.
 *
 * Mounted under `/internal` in `app.ts`. The path is named, not secret —
 * security comes from the shared-secret check + dispatch pairing, not
 * obscurity.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { findQueueDispatchState, recordEvent } from '../audit/store';
import type { AuthContext } from '../auth/context';
import type { Env } from '../env';
import { conversationStub } from '../memory/conversation-do';
import { constantTimeEqual } from '../security/constant-time';
import { ErrorBodySchema } from './openapi-shared';

const ToolResultEventSchema = z
  .object({
    kind: z.literal('tool_result').openapi({
      description: 'Must be `tool_result` — the only event kind this route accepts.',
    }),
    role: z.literal('tool').optional(),
    tool_call_id: z.string().min(1).openapi({
      description:
        "Matches the `tool_call_id` from the dispatching assistant turn's `tool_calls[]`.",
    }),
    name: z.string().min(1).openapi({
      description: 'Tool name the model knows this dispatch by.',
    }),
    content: z.string().openapi({
      description: 'The result string the model will see on its next turn.',
    }),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({
        description:
          'Free-form. By convention `{ job_id: "<id>" }` so the `queue_complete` audit row ' +
          'can be paired to the earlier `queue_dispatch`.',
      }),
  })
  .strict()
  .openapi('InternalToolResultEvent');

const WriteBackBodySchema = z
  .object({
    events: z.array(ToolResultEventSchema).min(1).max(50),
  })
  .strict()
  .openapi('InternalWriteBackRequest');

const WriteBackResponseSchema = z
  .object({
    ok: z.literal(true),
    written: z.number().int().nonnegative(),
  })
  .openapi('InternalWriteBackResponse');

const writeBackRoute = createRoute({
  method: 'post',
  path: '/sessions/{thread_id}/events',
  // Excluded from /openapi.json + Scalar: this is an internal back-channel
  // for queue consumers, not a client-facing API. The route still works and
  // still validates against the schemas below — it's just not advertised.
  hide: true,
  tags: ['Internal'],
  summary: 'Queue consumer write-back: land a tool_result on a session',
  description:
    'Internal back-channel for queue consumers. Authenticated by the shared secret in ' +
    '`x-consumer-secret` (compared against `env.CONSUMER_SHARED_SECRET`). Restricted to ' +
    '`tool_result` events. Forwards to the `ConversationDO` keyed by `thread_id` and emits a ' +
    '`queue_complete` audit row server-side. NOT for third-party callers — the `Internal` ' +
    'tag exists to make that explicit.',
  request: {
    params: z.object({
      thread_id: z
        .string()
        .min(3)
        .openapi({
          description:
            'Tenant-prefixed thread id (`<tenant>:<suffix>`). The tenant is parsed from the ' +
            'prefix and used for the `queue_complete` audit row.',
        }),
    }),
    headers: z.object({
      // Required operationally — but declared optional so the handler can
      // emit a precise 401 ("unauthorized") when missing instead of the
      // generic 400 OpenAPIHono returns for schema-validation failures.
      'x-consumer-secret': z.string().min(1).optional().openapi({
        description: 'Shared secret. Must match `env.CONSUMER_SHARED_SECRET`.',
      }),
    }),
    body: { content: { 'application/json': { schema: WriteBackBodySchema } } },
  },
  responses: {
    200: {
      description: 'Events were appended to the session.',
      content: { 'application/json': { schema: WriteBackResponseSchema } },
    },
    400: {
      description: 'Malformed thread_id, invalid body, or non-tool_result event.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    401: {
      description: 'Missing or wrong shared secret.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    409: {
      description:
        'No outstanding queue dispatch pairs to a `tool_call_id` (forged / cross-tenant / ' +
        'not-yet-visible), or the dispatch is already resolved (replay). Nothing is written.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    502: {
      description: 'Append to ConversationDO failed.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    503: {
      description:
        'CONSUMER_SHARED_SECRET is not configured, or the audit store (DB) needed to verify ' +
        'dispatch pairing is unavailable, on this deployment.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

function tenantFromThreadId(threadId: string): string | null {
  const colon = threadId.indexOf(':');
  if (colon <= 0 || colon === threadId.length - 1) return null;
  return threadId.slice(0, colon);
}

export function buildInternalRouter(): OpenAPIHono<{
  Bindings: Env;
  Variables: { auth: AuthContext };
}> {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

  app.openapi(writeBackRoute, async (c) => {
    const secret = c.env.CONSUMER_SHARED_SECRET;
    if (!secret) {
      return c.json(
        { error: 'internal write-back not configured on this deployment' },
        503,
      ) as never;
    }
    const supplied = c.req.header('x-consumer-secret') ?? '';
    if (!(await constantTimeEqual(supplied, secret))) {
      return c.json({ error: 'unauthorized' }, 401) as never;
    }

    // Dispatch pairing needs the audit store. Fail closed if it's absent —
    // the harness core always wires DB in staging/production; refusing here
    // is consistent with the missing-secret 503 above and never silently
    // skips the integrity check.
    if (!c.env.DB) {
      return c.json({ error: 'dispatch verification unavailable (no audit store)' }, 503) as never;
    }

    const { thread_id: threadId } = c.req.valid('param');
    const tenantId = tenantFromThreadId(threadId);
    if (!tenantId) {
      return c.json({ error: 'malformed thread_id (expected `tenant:suffix`)' }, 400) as never;
    }

    const body = c.req.valid('json');

    // Prove each event pairs to a REAL, still-outstanding queue dispatch for
    // this tenant + thread BEFORE anything is written. The shared secret is
    // fleet-global, so without this a forged `tool_call_id` (or one naming
    // another tenant's thread) would land a `tool_result` in a session it
    // never dispatched. The `queue_dispatch` audit row is tenant-scoped and
    // records the dispatching thread; a forged prefix has no such row.
    const dispatchManifest = new Map<string, string>();
    for (const e of body.events) {
      const state = await findQueueDispatchState(c.env, tenantId, e.tool_call_id);
      if (!state.dispatch) {
        return c.json(
          {
            error: 'no outstanding queue dispatch for this tool_call_id',
            detail: `tenant '${tenantId}' has no queue_dispatch row for tool_call_id '${e.tool_call_id}'`,
          },
          409,
        ) as never;
      }
      if (state.dispatch.threadId !== threadId) {
        return c.json(
          {
            error: 'queue dispatch targets a different thread',
            detail: `tool_call_id '${e.tool_call_id}' was dispatched on another thread, not '${threadId}'`,
          },
          409,
        ) as never;
      }
      if (state.resolved) {
        return c.json(
          {
            error: 'queue dispatch already resolved',
            detail: `tool_call_id '${e.tool_call_id}' already has a queue_complete/queue_expired row (replay)`,
          },
          409,
        ) as never;
      }
      dispatchManifest.set(e.tool_call_id, state.dispatch.manifestId);
    }

    const events = body.events.map((e) => ({
      kind: e.kind,
      role: 'tool' as const,
      tool_call_id: e.tool_call_id,
      name: e.name,
      content: e.content,
      ...(e.metadata ? { metadata: e.metadata } : {}),
    }));

    const stub = conversationStub(c.env, threadId);
    const resp = await stub.fetch('https://do/events', {
      method: 'POST',
      body: JSON.stringify({ events }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return c.json(
        { error: `session write failed: ${resp.status} ${detail.slice(0, 200)}` },
        502,
      ) as never;
    }

    // One queue_complete audit per resolved tool_call_id. Server-side
    // emission means the consumer doesn't have to also emit it, and a
    // misbehaving consumer can't skip the audit trail. The manifest id is
    // carried over from the paired `queue_dispatch` row (it was empty here
    // before — the consumer has no manifest context) so the completion row
    // sits under the same manifest as its dispatch.
    for (const e of body.events) {
      const jobId = (e.metadata as { job_id?: string } | undefined)?.job_id ?? '';
      recordEvent({
        tenantId,
        eventType: 'queue_complete',
        manifestId: dispatchManifest.get(e.tool_call_id) ?? '',
        status: 'ok',
        payload: {
          tool: e.name,
          tool_call_id: e.tool_call_id,
          thread_id: threadId,
          ...(jobId ? { job_id: jobId } : {}),
        },
      });
    }

    return c.json({ ok: true as const, written: body.events.length }, 200);
  });

  return app;
}
