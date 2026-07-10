/**
 * createApp — assembles the Hono app.
 *
 * Top-level uses `OpenAPIHono` so routes registered with `.openapi()` are
 * surfaced in `/openapi.json` and the Scalar reference UI at `/docs`.
 * Sub-routers that still use plain `Hono` work fine — their routes just
 * don't appear in the OpenAPI document until they're migrated. See
 * `@hono/zod-openapi` README on mixed-router composition.
 *
 * Every router takes the `ToolProvider` so there is *no* module-level
 * mutable state and tests can boot the app with a stub provider.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { buildAgentCard } from './a2a/card';
import { buildA2ARouter } from './a2a/server';
import { buildApprovalsRouter } from './api/approvals';
import { buildAuditRouter } from './api/audit';
import { buildChatRouter } from './api/chat';
import { buildConsentRouter } from './api/consent';
import { buildEvalRouter } from './api/eval';
import { buildGeoRouter } from './api/geo';
import { buildInternalRouter } from './api/internal';
import { buildJobsRouter } from './api/jobs';
import { buildManifestsRouter } from './api/manifests';
import { buildOpenAIRouter } from './api/openai-compat';
import { buildPlansRouter } from './api/plans';
import { recordEventDetached } from './audit/store';
import type { AuthContext } from './auth/context';
import { authMiddleware } from './auth/middleware';
import { buildAcpRouter } from './commerce/acp/router';
import { buildB2bQuotesRouter } from './commerce/b2b/quote-router';
import { buildB2bRouter } from './commerce/b2b/router';
import { buildBillingRouter } from './commerce/billing/router';
import { buildBrandsRouter } from './commerce/brands/router';
import { buildStorefrontRouter } from './commerce/storefront/router';
import { buildWidgetRouter } from './commerce/storefront/widget';
import { buildStructuredRootRouter, buildStructuredRouter } from './commerce/structured/router';
import { buildCommerceRouter } from './commerce/webhook';
import { buildDocsSiteRouter } from './docs/site';
import { buildEntitiesRouter } from './entities/router';
import type { Env } from './env';
import { loadManifest } from './manifests/loader';
import { buildMcpRouter } from './mcp/server';
import { recordCounter } from './observability/metrics';
import { getActiveBundle } from './policy/bundle';
import { rateLimitMiddleware } from './security/rate-limit';
import type { ToolProvider } from './tools/provider';

export interface AppOptions {
  tools: ToolProvider;
  /** Default manifest exposed under /a2a, /mcp, /.well-known/agent-card.json. */
  defaultManifest: string;
}

// Scalar reference UI theme — same neutral monochrome palette as the prose
// docs site (`src/docs/site.ts`): white background, near-black text, subtle
// gray accents (Tailwind's `neutral` scale). Maps onto Scalar's CSS variables;
// the UI is forced to light mode so the tones hold regardless of system
// preference. The active sidebar item uses a light-gray fill (no color accent).
const SCALAR_THEME_CSS = `
  .light-mode, .dark-mode, :root {
    --scalar-background-1: #ffffff;
    --scalar-background-2: #fafafa;
    --scalar-background-3: #f5f5f5;
    --scalar-border-color: #e5e5e5;
    --scalar-color-1: #0a0a0a;
    --scalar-color-2: #404040;
    --scalar-color-3: #737373;
    --scalar-color-accent: #171717;
    --scalar-button-1: #171717;
    --scalar-button-1-color: #fafafa;
    --scalar-button-1-hover: #0a0a0a;
    --scalar-sidebar-background-1: #fafafa;
    --scalar-sidebar-color-1: #0a0a0a;
    --scalar-sidebar-color-2: #737373;
    --scalar-sidebar-border-color: #e5e5e5;
    --scalar-sidebar-item-hover-background: #f5f5f5;
    --scalar-sidebar-item-hover-color: #0a0a0a;
    --scalar-sidebar-item-active-background: #f5f5f5;
    --scalar-sidebar-color-active: #0a0a0a;
    --scalar-sidebar-search-background: #ffffff;
    --scalar-sidebar-search-border-color: #e5e5e5;
    --scalar-sidebar-search-color: #737373;
  }
`;

const HealthResponseSchema = z
  .object({
    status: z.literal('ok'),
    env: z.enum(['development', 'staging', 'production']).openapi({ example: 'production' }),
    multi_region: z.boolean().openapi({ example: false }),
    federation: z
      .object({
        bundleVersion: z.string().openapi({ example: '2026.05.13-01' }),
        issuer: z.string().openapi({ example: 'felix-federation' }),
      })
      .nullable()
      .openapi({
        description:
          'PolicyBundle metadata once a signed bundle has been loaded from R2; null otherwise.',
      }),
  })
  .openapi('Health', {
    example: {
      status: 'ok',
      env: 'production',
      multi_region: false,
      federation: null,
    },
  });

const AgentCardCapabilitySchema = z
  .object({
    id: z.string(),
    description: z.string(),
    input_schema_ref: z.string(),
  })
  .openapi('AgentCardCapability');

const AgentCardContainerSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    image: z.string(),
  })
  .openapi('AgentCardContainer');

const AgentCardQueueSchema = z
  .object({
    name: z.string(),
    description: z.string(),
  })
  .openapi('AgentCardQueue');

const AgentCardResponseSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    version: z.string(),
    protocols: z.array(z.string()),
    endpoints: z.record(z.string(), z.string()),
    auth: z.object({
      schemes: z.array(z.string()),
      required_scopes: z.array(z.string()),
      allow_anonymous: z.boolean(),
    }),
    capabilities: z.array(AgentCardCapabilitySchema),
    containers: z.array(AgentCardContainerSchema),
    queues: z.array(AgentCardQueueSchema),
    federation: z.object({ bundleVersion: z.string(), issuer: z.string() }).nullable(),
  })
  .openapi('AgentCard');

export function createApp(
  opts: AppOptions,
): OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }> {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

  // Cap request bodies before any handler buffers them. The ceiling
  // accommodates the storefront visual-search image upload (8 MB, see
  // storefront/router.ts) with form/multipart overhead; JSON surfaces are far
  // smaller. Guards against a single oversized body exhausting isolate memory.
  app.use(
    '*',
    bodyLimit({
      maxSize: 12 * 1024 * 1024,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
  );

  app.use('*', authMiddleware());
  // Rate limit runs after auth so it can key on the resolved tenant id.
  // It skips /health, /.well-known/*, /docs, /openapi.json internally —
  // see rate-limit.ts.
  app.use('*', rateLimitMiddleware());

  // Unhandled-exception boundary. `HTTPException` carries its own response
  // (used by routes that throw 4xx); everything else is treated as a bug
  // and turned into a structured 500 + counter so it shows up in Workers
  // Logs and the metrics pipeline rather than as an opaque platform 1101.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const auth = c.get('auth');
    const path = new URL(c.req.url).pathname;
    const tenantId = auth?.principal.tenantId ?? 'default';
    recordCounter('orchestrator_unhandled_error', {
      path,
      method: c.req.method,
      tenant_id: tenantId,
    });
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'unhandled_exception',
        path,
        method: c.req.method,
        tenant_id: tenantId,
        message: err.message,
        stack: err.stack,
      }),
    );
    // Audit log too so tenant operators see unhandled errors in /audit
    // alongside everything else. The auth middleware's runWithContext has
    // already unwound by the time onError fires, so use the detached
    // variant and read env/execCtx straight off the Hono context. Stack
    // intentionally omitted from the persisted payload — it stays in
    // Workers Logs only.
    let execCtx: ExecutionContext | undefined;
    try {
      execCtx = c.executionCtx;
    } catch {
      execCtx = undefined;
    }
    recordEventDetached(
      c.env,
      {
        tenantId,
        eventType: 'unhandled_error',
        principalSubject: auth?.principal.subject,
        status: 'error',
        payload: { path, method: c.req.method, message: err.message },
      },
      execCtx,
    );
    return c.json({ error: { message: 'internal error' } }, 500);
  });

  // -------------------------------------------------------------------
  // Documented public surface
  // -------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: 'get',
      path: '/health',
      tags: ['System'],
      summary: 'Liveness + federation status',
      responses: {
        200: {
          description: 'Worker is up. Includes the env tag and the active PolicyBundle metadata.',
          content: { 'application/json': { schema: HealthResponseSchema } },
        },
      },
    }),
    (c) => {
      const bundle = getActiveBundle();
      return c.json(
        {
          status: 'ok' as const,
          env: c.env.ENVIRONMENT,
          multi_region: false,
          federation: bundle ? { bundleVersion: bundle.version, issuer: bundle.issuer } : null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/.well-known/agent-card.json',
      tags: ['System'],
      summary: 'A2A agent card for the default manifest',
      responses: {
        200: {
          description:
            "Discovery document used by A2A peers to learn this orchestrator's endpoints, " +
            'auth requirements, and declared capabilities.',
          content: { 'application/json': { schema: AgentCardResponseSchema } },
        },
      },
    }),
    (c) => {
      const baseUrl = new URL(c.req.url).origin;
      const card = buildAgentCard(loadManifest(opts.defaultManifest), {
        baseUrl,
        mcpEnabled: true,
      });
      return c.json(card, 200);
    },
  );

  // Self-issued JWKS. When `JWKS_PUBLIC` (a JWKS JSON document) is configured,
  // this worker is its own OIDC-style issuer: set `JWT_VERIFIERS` to
  // `cognito https://<this-host>` and mint tokens with the matching private key
  // (see scripts/mint-jwt.ts). Used for staging write-testing without a 3p IdP.
  // Public keys only — safe to serve. 404 when unset.
  app.get('/.well-known/jwks.json', (c) => {
    const jwks = c.env.JWKS_PUBLIC;
    if (!jwks) return c.json({ error: 'not_configured' }, 404);
    return new Response(jwks, {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    });
  });

  // -------------------------------------------------------------------
  // Sub-routers
  // -------------------------------------------------------------------
  app.route('/v1', buildOpenAIRouter({ tools: opts.tools }));
  app.route('/chat', buildChatRouter({ tools: opts.tools }));
  app.route('/internal', buildInternalRouter());
  app.route('/commerce', buildCommerceRouter());
  app.route('/commerce', buildConsentRouter());
  app.route('/acp', buildAcpRouter());
  app.route('/brands', buildBrandsRouter());
  app.route('/shop', buildStorefrontRouter({ tools: opts.tools }));
  app.route('/widget', buildWidgetRouter());
  app.route('/structured', buildStructuredRouter());
  // Crawler-facing root aliases (/robots.txt, /sitemap.xml, /.well-known/ai-catalog.json),
  // host-resolved to a brand. Mounted at root where answer engines look.
  app.route('/', buildStructuredRootRouter());
  app.route('/entities', buildEntitiesRouter());
  app.route('/b2b', buildB2bRouter());
  app.route('/b2b', buildB2bQuotesRouter());
  app.route('/b2b/billing', buildBillingRouter());
  app.route('/audit', buildAuditRouter());
  app.route('/geo', buildGeoRouter());
  app.route('/approvals', buildApprovalsRouter());
  app.route('/plans', buildPlansRouter());
  app.route('/jobs', buildJobsRouter());
  app.route('/manifests', buildManifestsRouter());
  app.route('/eval', buildEvalRouter({ tools: opts.tools }));
  app.route('/a2a', buildA2ARouter({ tools: opts.tools, defaultManifest: opts.defaultManifest }));
  app.route('/mcp', buildMcpRouter({ tools: opts.tools, defaultManifest: opts.defaultManifest }));

  // -------------------------------------------------------------------
  // OpenAPI spec + Scalar UI
  // -------------------------------------------------------------------
  // `doc31` emits OpenAPI 3.1.0 (vs `doc` which emits 3.0.x). 3.1 brings
  // full JSON Schema 2020-12 alignment — nullable types, const, examples
  // as an array, etc. — which matches the zod-to-openapi output more
  // faithfully than 3.0's restricted subset.
  //
  // The bearer security scheme is registered as a *component*; individual
  // routes can opt in via `security: [{ bearerAuth: [] }]` once they
  // require auth. We don't apply it globally because many endpoints
  // (health, discovery, docs) are public.
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'Cloudflare Access or Cognito-issued JWT. Configure verifiers via ' +
      'the JWT_VERIFIERS env var. Anonymous (no header) is allowed when ' +
      'the target manifest sets `auth.inbound.allow_anonymous: true`.',
  });

  app.doc31('/openapi.json', (c) => {
    const origin = new URL(c.req.url).origin;
    // On-site guide URL: `getting-started.md` → `/docs/guide/getting-started`,
    // preserving any `#fragment`. The rendered prose lives at these routes
    // (see `src/docs/site.ts`), so links keep users on the deployment.
    const guide = (path: string) => {
      const [file = '', frag] = path.split('#');
      return `${origin}/docs/guide/${file.replace(/\.md$/, '')}${frag ? `#${frag}` : ''}`;
    };
    return {
      openapi: '3.1.0',
      info: {
        title: 'Felix',
        version: '1.0.0',
        summary: 'Manifest-driven agent runtime on Cloudflare Workers.',
        description: [
          'Felix compiles an `apiVersion: orchestrator/v1` manifest into a runnable',
          'agent and exposes it over four protocols:',
          '',
          '- **OpenAI-compatible** — `/v1/chat/completions` (sync + SSE)',
          '- **A2A JSON-RPC** — `/a2a`',
          '- **MCP HTTP JSON-RPC** — `/mcp`',
          '- **Direct REST/SSE** — `/chat`, `/chat/stream`',
          '',
          'Management surfaces (`/audit`, `/plans`, `/jobs`, `/approvals`, `/manifests`)',
          'cover observability, HITL approvals, and tenant-managed manifest CRUD.',
          'Every D1 row is keyed by `(tenant_id, id)` and thread ids are',
          'server-prefixed by the authenticated tenant — transcripts cannot cross',
          'tenants.',
          '',
          '## Try it',
          '',
          'Pick a server above (or set `BASE_URL`). The bundled `quick` manifest',
          'accepts anonymous traffic, so no token is required:',
          '',
          '```bash',
          'curl -s -X POST "$BASE_URL/chat" \\',
          "  -H 'content-type: application/json' \\",
          `  -d '{"manifest":"quick","messages":[{"role":"user","content":"What is 7 * 6?"}]}' | jq`,
          '```',
          '',
          'Any OpenAI SDK works — point `baseURL` at `$BASE_URL/v1` and use a',
          'manifest name as the `model`. Add `"stream": true` for SSE.',
          '',
          '## Authentication',
          '',
          'Send `Authorization: Bearer <jwt>` — Cloudflare Access or Cognito tokens,',
          'verified at the edge (configure via `JWT_VERIFIERS`). Invalid or expired',
          'tokens return 401; they do **not** silently demote to anonymous.',
          'Anonymous requests succeed only against manifests that set',
          '`spec.auth.inbound.allow_anonymous: true`. Rate limit: 100 req/60s per',
          'tenant; `/health`, `/.well-known/*`, `/docs`, and `/openapi.json` are',
          'exempt.',
          '',
          '## Read more',
          '',
          `- [Getting started](${guide('getting-started.md')})`,
          `- [Concepts](${guide('concepts.md')}) — manifests, tenants, threads, patterns`,
          `- [Manifest reference](${guide('manifest-reference.md')})`,
          `- [REST API](${guide('rest-api.md')}) — worked examples for every route`,
          `- [Management API](${guide('management-api.md')}) — audit, plans, jobs, approvals, manifests`,
          `- [Deploy](${guide('deploy.md')})`,
        ].join('\n'),
        contact: { name: 'Felix', url: 'https://make.felix.run' },
        license: { name: 'MIT', identifier: 'MIT' },
        termsOfService: 'https://make.felix.run/terms',
        'x-logo': {
          url: 'https://make.felix.run/logo.svg',
          altText: 'Felix',
        },
      },
      externalDocs: {
        url: `${origin}/docs/home`,
        description: 'Felix documentation — guides & internals',
      },
      servers: (() => {
        const known = [
          { url: 'https://make.felix.run', description: 'Production' },
          { url: 'https://staging-make.felix.run', description: 'Staging' },
        ];
        return known.some((s) => s.url === origin)
          ? known
          : [...known, { url: origin, description: 'This deployment' }];
      })(),
      tags: [
        {
          name: 'System',
          description:
            'Liveness probe and A2A discovery card. Unauthenticated and exempt from rate ' +
            'limit — safe to hit from cold clients before any token is obtained.',
        },
        {
          name: 'OpenAI',
          description:
            'OpenAI-compatible chat completions. Drop-in for any OpenAI SDK: point `baseURL` ' +
            'at `/v1` and use a Felix manifest name as the `model`. Threading is opt-in via ' +
            'the `x-thread-id` header — without it each request is stateless, with it the ' +
            "server prefixes the tenant id so the suffix you supply joins your tenant's " +
            'namespace.',
          externalDocs: {
            url: guide('rest-api.md#openai-compatible'),
            description: 'Worked examples',
          },
        },
        {
          name: 'Threads',
          description:
            'Felix-native conversational surface — sync `POST /chat`, SSE `POST /chat/stream`, ' +
            'and transcript fetch/reset under `/chat/history/{thread_id}`. Thread ids are ' +
            '**suffixes**; the server enforces a `<tenant_id>:` prefix and rejects suffixes ' +
            'containing `:` or `#` with HTTP 400. Anonymous callers can chat against manifests ' +
            'that allow them but cannot read or delete history.',
          externalDocs: { url: guide('rest-api.md#post-chat'), description: 'Threading model' },
        },
        {
          name: 'A2A',
          description:
            'Agent-to-Agent JSON-RPC 2.0 over HTTP. Five methods: `tasks/send`, ' +
            '`tasks/sendSubscribe` (returns SSE), `tasks/get`, `tasks/cancel`, ' +
            '`tasks/resubscribe`. Each task is ' +
            'persisted on a per-(tenant, task) Durable Object — cross-tenant probes return ' +
            '`-32001 task not found` rather than leaking existence. The task id doubles as ' +
            'the conversation thread id, so a continuation task with the same id resumes the ' +
            'prior transcript.',
          externalDocs: { url: guide('rest-api.md#post-a2a'), description: 'JSON-RPC reference' },
        },
        {
          name: 'MCP',
          description:
            'Model Context Protocol over HTTP JSON-RPC. Two methods: `tools/list` returns ' +
            "the default manifest's wrapped tools (with JSON Schema for arguments); " +
            '`tools/call` invokes one and returns its rendered text. Remote MCP tools whose ' +
            '`inputSchema` is already JSON Schema are forwarded verbatim so descriptions and ' +
            'enums survive the round trip.',
          externalDocs: { url: guide('rest-api.md#post-mcp'), description: 'MCP reference' },
        },
        {
          name: 'Manifests',
          description:
            'Tenant-managed manifest CRUD with a four-layer resolver (tenant D1 → tenant R2 ' +
            '→ global R2 → bundled). Versions are append-only and the active pointer can be ' +
            'rolled back without losing history. Reads require the `manifests:read` scope; ' +
            'writes require `manifests:write`. Queries are tenant-scoped automatically.',
          externalDocs: {
            url: guide('manifest-reference.md'),
            description: 'Manifest field reference',
          },
        },
        {
          name: 'Audit',
          description:
            'Append-only audit event log. Every governance decision (policy, limit, ' +
            'guardrail, approval), tool call, peer dispatch, plan step, and job run lands ' +
            'here, scoped to the calling tenant. Events are batched through the audit queue ' +
            'and flushed to D1 in ≤50-row chunks.',
          externalDocs: {
            url: guide('management-api.md#audit'),
            description: 'Event types & filters',
          },
        },
        {
          name: 'Approvals',
          description:
            'Human-in-the-loop queue. Tools listed under an `approvals` rule in a manifest ' +
            'pause on first call, persist an `approval_request` row, and return a deny ' +
            'string to the model. The approver posts `/approvals/{id}/decide`; the next ' +
            'retry with the same arguments goes through. Concurrent decisions on the same ' +
            'id are serialized through a per-(tenant, id) Durable Object.',
          externalDocs: { url: guide('management-api.md#approvals'), description: 'Approval flow' },
        },
        {
          name: 'Plans',
          description:
            'Persisted plan/step state for the `deep` pattern. Each plan has an id, ' +
            'optional title, and an ordered list of steps with `pending` / `in_progress` / ' +
            '`completed` / `skipped` / `failed` status. The model updates steps with the ' +
            '`plan_update_step` tool as work progresses; this endpoint exposes the read view.',
          externalDocs: { url: guide('management-api.md#plans'), description: 'Plan lifecycle' },
        },
        {
          name: 'Jobs',
          description:
            'Scheduled job registry. Jobs declare a cron `schedule`, a `manifest_id`, and an ' +
            "optional `payload`; the cron sweep runs them under their owning tenant's " +
            'identity. `POST /jobs/run/{name}` triggers a manual run for ops or backfills. ' +
            '`tenant_id` is overwritten server-side from the authenticated principal — ' +
            'callers cannot impersonate another tenant.',
          externalDocs: {
            url: guide('management-api.md#jobs'),
            description: 'Cron syntax & payloads',
          },
        },
        {
          name: 'Eval',
          description:
            'Golden-dataset eval harness. Datasets and their items are tenant-scoped and ' +
            'append-only; `POST /eval/datasets/{name}/run` scores a dataset with the ' +
            'configured judge (deterministic / Workers-AI / panel) plus trajectory rubrics, ' +
            'and persists an `eval_run` row readable under `/eval/runs`. Backs the `pnpm eval` ' +
            'CI gate.',
          externalDocs: {
            url: guide('management-api.md#eval'),
            description: 'Datasets, judges & runs',
          },
        },
      ],
    };
  });

  app.get(
    '/docs',
    Scalar({
      url: '/openapi.json',
      pageTitle: 'Felix · API reference',
      favicon: 'https://make.felix.run/favicon.svg',
      // Layout / theme polish. `modern` is the cleanest Scalar layout. The
      // built-in `theme` is set to `none` so it doesn't fight `customCss`,
      // which carries the warm cream palette; light mode is forced so the
      // tones hold regardless of system preference.
      layout: 'modern',
      theme: 'none',
      forceDarkModeState: 'light',
      hideDarkModeToggle: true,
      customCss: SCALAR_THEME_CSS,
      defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
      hideDownloadButton: false,
      searchHotKey: 'k',
    }),
  );

  // -------------------------------------------------------------------
  // Rendered prose docs (guide + internals)
  // -------------------------------------------------------------------
  // Mounted under `/docs/...` sub-paths. Registered *after* the exact
  // `/docs` Scalar route above, and the router defines no bare `GET /`,
  // so Scalar keeps ownership of `/docs` while the guide/internals pages
  // live at `/docs/home`, `/docs/guide/*`, `/docs/internals/*`.
  app.route('/docs', buildDocsSiteRouter());

  return app;
}
