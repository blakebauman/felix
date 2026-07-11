---
description: "End-to-end request flow through the Felix Worker — entry points, middleware chain, Durable Object topology, and per-isolate caches."
---

# Architecture

How a request flows through Felix end-to-end. This document is for contributors who need to find where a particular concern is handled.

## Worker entrypoint

The deployable Worker shell is the `@felix/api` app: `apps/api/src/index.ts` exports a `default` object with three handlers: `fetch`, `scheduled`, `queue`. It consumes this package through `@felix/harness/<path>` source exports; paths written as `src/...` in this document are inside `packages/harness/`.

```
ExportedHandler<Env, AuditEvent>
  fetch(request, env, ctx)          inbound HTTP
  scheduled(event, env, ctx)        cron *\/10 * * * *
  queue(batch, env)                 felix-audit queue consumer
```

The Hono app is built lazily and cached at the module top:

```ts
let cachedTools: ToolProvider | null = null;
let cachedApp: ReturnType<typeof createApp> | null = null;
function toolsFor(env: Env): ToolProvider {
  if (!cachedTools) cachedTools = compose(env);
  return cachedTools;
}
function appFor(env: Env): ReturnType<typeof createApp> {
  if (!cachedApp) {
    cachedApp = createApp({ tools: toolsFor(env), defaultManifest: 'quick' });
  }
  return cachedApp;
}
```

`compose(env)` (`apps/api/src/composition.ts`) is the only place that wires Felix's tool catalog into the harness's `ToolProvider`. It runs once per isolate (memoized separately from the app so the scheduled handler can reuse it). `createApp` returns an `OpenAPIHono` app — already-OpenAPI-registered routes appear in `/openapi.json`, plain `Hono` sub-routers work but don't show up in the spec until migrated.

The four Durable Object classes and the `AgentWorkflow` are re-exported here, mirroring `wrangler.jsonc:durable_objects.bindings` and `workflows[]`:

```ts
export { ConversationDO } from '@felix/harness/memory/conversation-do';
export { A2ATaskDO } from '@felix/harness/a2a/task-do';
export { ApprovalsDO } from '@felix/harness/approvals/approvals-do';
export { FederationDO } from '@felix/harness/policy/federation-do';
export { AgentWorkflow } from './agent-workflow';
```

`AgentWorkflow` itself lives in the app (`apps/api/src/agent-workflow.ts`); its params type stays in the harness at `src/workflows/types.ts`.

## Middleware chain

`src/app.ts`:

```ts
app.use('*', bodyLimit({ maxSize: max(1 MB core floor, ...plugin bodyLimitBytes), onError: … }));  // 413 payload_too_large
app.use('*', authMiddleware({ selfAuthenticatingMounts }));   // mounts contributed by plugins
app.use('*', rateLimitMiddleware({ keyResolvers }));          // resolvers contributed by plugins
```

All three run before every route. Order matters: the body cap (the commerce plugin raises it to 12 MB for the storefront visual-search image upload) rejects oversized payloads before any parsing; auth runs before the rate limiter so it can key on the resolved tenant id.

A small set of mounts is **self-authenticating** (`selfAuthenticatingMounts` on a plugin, threaded into `authMiddleware` — currently `/acp` from the commerce plugin): the middleware still installs an anonymous `RequestContext` but skips JWT bearer parsing, because the mount enforces its own credential (constant-time `ACP_API_KEY` compare) inside the router.

### authMiddleware

`src/auth/middleware.ts`. Behavior matrix:

| Inbound header | Action |
|---|---|
| (none) | Anonymous context (`tenantId = 'default'`); route decides via `enforceManifestAuth` whether anonymous is allowed. |
| `Bearer <valid>` | Verify via configured verifiers; populate `auth` with the resolved principal. |
| `Bearer <expired or malformed>` | 401 with `www-authenticate: Bearer error="..."`. Never demotes to anonymous in non-dev. |
| `Bearer <token>` with no verifiers configured | 401 in non-dev (`reason: no_verifiers_configured`); falls through to anonymous in dev. |
| `Bearer <iss not matched>` | Falls through to anonymous (lets unit tests / cross-env probes work). |

After resolving `auth`, the middleware installs the `RequestContext` and runs the rest of the request inside `runWithContext`:

```ts
const ctx: RequestContext = {
  env,
  execCtx,        // ExecutionContext, may be undefined in unit tests
  auth,           // AuthContext { principal, outboundToken }
  limitState,     // fresh LimitState { toolCalls: 0, peerHops: 0, startedAt, auditCount: 0,
                  //                    abortController, tokens: { input: 0, output: 0 }, ... }
};
return runWithContext(ctx, async () => { try { await next(); } finally { disposeLimitState(ctx.limitState); } });
```

`RequestContext` (`src/context.ts`) propagates via `AsyncLocalStorage<RequestContext>`. Tool wrappers (limits, policies, approvals) read it through `getContext()` rather than threading it as a parameter, which keeps the tool authoring surface clean. The middleware always tears the state down in `finally` via `disposeLimitState` so a hung tool can't outlive the request that started it.

### rateLimitMiddleware

`src/security/rate-limit.ts`. Reads `c.env.TENANT_RATE_LIMIT` and keys on `principal.tenantId`, after consulting plugin-contributed `keyResolvers` in order (the commerce plugin derives per-storefront / per-host / ACP buckets for its public anonymous surfaces). Soft-fails open if the binding is absent (unit tests, dev probes without the unsafe binding wired). Skips `/health`, `/.well-known/*`, `/docs`, `/openapi.json`.

## App composition

`src/app.ts`:

```
OpenAPIHono<{ Bindings: Env, Variables: { auth: AuthContext } }>
  use bodyLimit (12 MB)
  use authMiddleware
  use rateLimitMiddleware
  openapi  GET  /health
  openapi  GET  /.well-known/agent-card.json
  get      GET  /.well-known/jwks.json              (self-issued JWKS from env.JWKS_PUBLIC; 404 when unset)
  route    /v1          buildOpenAIRouter
  route    /chat        buildChatRouter
  route    /internal    buildInternalRouter         (queue consumers POST tool_results here; x-consumer-secret)
  route    /audit       buildAuditRouter            (incl. /audit/metrics, /audit/ab)
  route    /approvals   buildApprovalsRouter
  route    /plans       buildPlansRouter
  route    /jobs        buildJobsRouter
  route    /manifests   buildManifestsRouter        (incl. /:name/canary, /:name/rollback)
  route    /eval        buildEvalRouter
  route    /a2a         buildA2ARouter
  route    /mcp         buildMcpRouter
  for each plugin: plugin.routes(app, { tools })     (feature plugins — see src/plugins/types.ts)
    commerce plugin mounts:
      route    /commerce    buildCommerceRouter         (Stripe webhook) + buildConsentRouter (consents, attribution)
      route    /acp         buildAcpRouter              (Agentic Commerce Protocol; ACP_API_KEY bearer)
      route    /brands      buildBrandsRouter           (D2C brand provisioning, catalog import, domains)
      route    /shop        buildStorefrontRouter       (public per-brand storefront chat + visual search)
      route    /widget      buildWidgetRouter           (embeddable chat widget loader + frame)
      route    /structured  buildStructuredRouter       (schema.org JSON-LD feeds, sitemap, robots)
      route    /            buildStructuredRootRouter   (root robots.txt, sitemap.xml, .well-known/ai-catalog.json)
      route    /entities    buildEntitiesRouter         (entity data-source seam: config, sync, push)
      route    /b2b         buildB2bRouter + buildB2bQuotesRouter
      route    /b2b/billing buildBillingRouter
      route    /geo         buildGeoRouter              (GEO/AEO tracked queries + observations)
  doc31    GET  /openapi.json    -> OpenAPI 3.1.0
  get      GET  /docs            -> Scalar UI rendered from /openapi.json
  get      /docs/home, /docs/guide/*, /docs/internals/*   -> 301 to docs.felix.run (prose site, apps/docs)
  onError  app.onError            -> HTTPException passthrough; everything else
                                    becomes 500 + recordEventDetached(unhandled_error)
                                    + orchestrator_unhandled_error counter
```

Every router is constructed from `AppOptions { tools: ToolProvider, defaultManifest: string }` — no module-level state. Tests boot the app with a stub provider.

## Per-isolate caches

Two distinct caches live at the module top:

1. `cachedApp` + `cachedTools` in `apps/api/src/index.ts` — the Hono app and (separately memoized) `ToolProvider`. Per isolate, indefinite lifetime.
2. Per-router agent cache, e.g. `src/api/chat.ts` and `src/api/openai-compat.ts`: `Map<manifestName, Promise<Agent>>`. Avoids rebuilding the agent on every request when the same manifest is hit repeatedly. Per isolate, indefinite lifetime.

Per-request state (`RequestContext`, `LimitState`, threadId, manifestId) lives in `AsyncLocalStorage` and dies with the request.

:::note[Cache invalidation]
The per-isolate agent cache has no TTL. A newly deployed manifest only takes effect in a fresh isolate — Cloudflare Workers evicts isolates frequently in practice, so propagation is typically within seconds to minutes. If you need immediate rollout, use the `/manifests` API with per-tenant D1 versions, which are resolved at request time (bypassing the cache per-manifest-name lookup).
:::

## Durable Object inventory

Four DO classes; each owns a distinct piece of stateful concern.

### ConversationDO

`src/memory/conversation-do.ts`. One DO per thread id. Stores the session event log and exposes:

- `GET /events?from=N&to=N&limit=N&kinds=k1,k2` — return `{ events: SessionEvent[], head: number }`. `from` is inclusive seq, `to` exclusive, `kinds` filters by kind discriminator.
- `GET /head` — return `{ seq: next-seq-to-be-assigned }`.
- `POST /events` with `{ events: AppendableEvent[] }` — batched append, atomic via `blockConcurrencyWhile` (one DO round-trip per react step).
- `DELETE /events` — wipe.

Each `SessionEvent` carries a monotonic `seq`, a `kind` (`message` / `tool_result` / `tool_call` / `thinking` / `audit`), the message-shaped payload (`role`, `content`, `tool_call_id?`, `name?`, `tool_calls?`), and optional `metadata`. `blockConcurrencyWhile` serializes writes so parallel sub-agents writing the same thread cannot race. Storage migrates a legacy `messages: StoredMessage[]` shape to events on first read.

The DO is the storage layer; consumers go through the `Session` abstraction (`src/session/do-session.ts`) which a `SessionStrategy` (`src/session/strategies.ts`) renders to a `ChatMessage[]` working set.

### A2ATaskDO

`src/a2a/task-do.ts`. One DO per `${tenantId}#${taskId}`. Owns A2A task lifecycle state — `pending` → `in_progress` → `completed | cancelled | failed`. Endpoints: `/init`, `/get`, `/complete`, `/cancel`. Cross-tenant reads fail because the DO key encodes the tenant prefix.

### ApprovalsDO

`src/approvals/approvals-do.ts`. One DO per `${tenantId}#${approvalId}`. The DO is a critical section, not the system of record — its only job is to serialize the `decide` writes for a given approval. The actual rows live in D1. The route handler (`/approvals/:id/decide`) pre-checks tenant ownership in D1 before routing to the DO, so a cross-tenant probe returns 404 without locking the DO.

### FederationDO

`src/policy/federation-do.ts`. Singleton (id derived from the name `singleton`). Holds the current active `PolicyBundle` and the timestamp of the last R2 refresh. The cron handler calls `/refresh`; route handlers call `/get`. The bundle is also cached process-locally in `src/policy/bundle.ts` via `syncFederationCache`.

## Scheduled handler

`apps/api/src/index.ts:scheduled`. Runs every 10 minutes per `wrangler.jsonc:triggers.crons`. The body is wrapped in `runWithContext(buildAnonymousContext(env, ctx), …)` + `disposeLimitState` in `finally` so audit events actually persist (the producer falls back to `console.log` when no context is installed) and any inner agent invocation has a fresh `LimitState`.

```
scheduled(_event, env, ctx):
  const reqCtx = buildAnonymousContext(env, ctx)
  ctx.waitUntil(runWithContext(reqCtx, async () => {
    try {
      await federationStub(env).fetch('https://do/refresh')   // refresh PolicyBundle from R2
      await runScheduledJobs(env)                              // sweep jobs table, run due ones
      await sweepOrphanQueueDispatches(env)                    // resolve stale queue dispatches
      await runAnomalyScan(env)                                // per-tool error-rate anomaly scan
      await runContinuousEvalTick(env, tools, opts, now, ctx)  // online-benchmark in-flight canaries
      for each plugin cronTask: task.run({ env, tools, now, execCtx })
        // commerce: abandoned_cart_scan (flag carts with intent but no purchase)
        // commerce: geo_monitor_tick (replay tracked queries through a generative engine)
    } finally {
      disposeLimitState(reqCtx.limitState)
    }
  }))
```

Each step is wrapped in its own `try/catch` so one failure doesn't abort the rest of the sweep.

`runScheduledJobs` (`src/jobs/cron.ts`) loads up to 500 jobs whose `next_run_at <= now`, re-verifies the cron expression against the current minute (`cronMatches`) to defend against index over-selection, records the run, and recomputes `next_run_at`. Failures are recorded as `last_status: error` and audit-logged but don't abort the sweep.

Additional cron work lands in the same handler — three core jobs plus every installed plugin's `cronTasks` (each isolated in its own `try/catch`):

- `sweepOrphanQueueDispatches(env)` (`src/jobs/queue-orphan-cleanup.ts`) — writes a synthetic `[expired]` `tool_result` for any `queue_dispatch` older than its deadline without a paired `queue_complete` / `queue_expired`, so an async (`queue` transport) cycle can resolve even when the consumer is unreachable.
- `runAnomalyScan(env)` (`src/jobs/anomaly-detector.ts`) — sweeps the last cron window of `audit_events` (tool_call rows), computes per-`(tenant, manifest, tool, error_code)` error rates, fires `anomaly_detected` events when an error rate is 3σ above a 24h EWMA baseline. When the offending `manifest_id` matches a current canary pointer, atomically sets `canary_weight = 0` and emits `auto_rollback`.
- `abandoned_cart_scan` (commerce plugin; `packages/commerce/src/personalization/abandoned-cart-job.ts`) — scans `behavior_events` for threads with purchase intent (`add_to_cart` / `checkout_start`) but no `purchase`, idle over an hour; records `abandoned_carts` rows (deduped), emits `cart_abandoned` audit events, and dispatches to `COMMERCE_RECOVERY_WEBHOOK` when configured. See [the commerce docs](../../../commerce/docs/index.md).
- `geo_monitor_tick` (commerce plugin; `packages/commerce/src/geo/monitor-job.ts`) — replays each tenant's tracked shopping queries (`geo_queries`) through a generative engine and records brand presence/rank/competitors into `geo_observations`. Tuned via the `GEO_MONITOR` env JSON. See [the commerce docs](../../../commerce/docs/index.md).
- `runContinuousEvalTick(env, tools, opts, now, ctx)` (`src/jobs/continuous-eval.ts`) — online benchmarking of in-flight canaries. For every manifest with a live canary (`listActiveCanaries`), it samples recent production inputs (captured as `user_input` on `tool_call` audit rows by the react loop) within the last window, replays each through the canary *version* (built directly from the versioned manifest, not the stable/canary resolver), scores the response with the Workers-AI judge against a generic quality rubric, and emits `judge_score` events tagged `payload.source: 'continuous'` under the canary's tenant — a regression shows up as a drop in the canary's pass rate vs. its stable baseline. Stateless: time-windowed sampling like the anomaly detector, with a deterministic per-input hash gate (`sample_rate`) and a hard `max_replays_per_tick` cap. Replays run under the anonymous cron context so their own `tool_call` rows land under `default` and are never re-sampled (`listActiveCanaries` skips `default`); each replay gets a fresh `LimitState`.

## Queue handler

`apps/api/src/index.ts:queue`. Bound to the `felix-audit` queue. Like `scheduled`, runs outside `authMiddleware`; the persist path doesn't need a `RequestContext` itself because the event bodies were redacted at producer time.

```
queue(batch, env):
  if batch.queue !== 'felix-audit': return
  try:
    await persistBatch(env, batch.messages.map(m => m.body))   // single DB.batch() up to 50 rows
    for m in batch.messages: m.ack()
    return
  catch:
    log
    for m in batch.messages:
      try:
        await persistBatch(env, [m.body])
        m.ack()
      catch:
        m.retry({ delaySeconds: 30 })
```

The two-phase approach guards against poison-row scenarios: a single bad event in a 50-row batch won't block audit writes for every tenant on retry.

## Request lifecycle (chat path)

For `POST /chat` or `POST /v1/chat/completions`:

```
fetch(request, env, ctx)
  appFor(env).fetch(request, env, ctx)
    authMiddleware
      verify JWT (jose) -> Principal { tenantId, subject, scopes }
      build AuthContext { principal, outboundToken }
      install RequestContext via runWithContext (AsyncLocalStorage)
    rateLimitMiddleware
      env.TENANT_RATE_LIMIT.limit({ key: tenantId })
    route handler (openai-compat.ts or chat.ts)
      enforceManifestAuth(c, manifest)        -> 401/403 or null
      resolve threadId = `${tenantId}:${suffix}`
      resolveManifest(env, tenantId, name)   -> ResolvedManifest { manifest, source, variant, cacheKey }
                                                  walks tenant D1 -> tenant R2 -> global R2 -> bundled
                                                  picks stable|canary via SHA-256 hash routing
      getAgent(env, resolved)                 -> cached Promise<Agent>
        buildAgent(manifest, deps)
          1. validateManifest  (queries isMultiAgentPattern from pattern registry)
          2. resolveSystemPrompt (soul + base + inline)
          3. getSessionStore(env, memory.checkpointer) + getSessionStrategy(spec.session.strategy)
          4. composeSkills (overlay with per-tenant activation)
          5. bindExternalMcp for each mcp_servers[]       -> McpExecutor per remote tool (transport: 'mcp')
          6. makePeerTool for each peers[]                -> A2AExecutor per peer (transport: 'a2a')
          6b. makeContainerTool for each containers[]     -> ContainerExecutor (transport: 'container')
          6c. makeQueueTool for each queues[]             -> QueueExecutor (transport: 'queue')
          6d. makeSandboxTool for each sandboxes[]        -> SandboxExecutor (transport: 'sandbox')
          6e. makeBrowserTool for each browser_tools[]    -> BrowserExecutor (transport: 'browser')
          7. resolve sub_agents (multi-agent) or tools (single-agent); auto-inject memory tools,
             recall_procedure (procedural memory), fetch_artifact (artifacts spill)
          8. governance pipeline: mergeWithManifest -> applyPolicies -> applyLimits ->
             applyGuardrails -> applyJudges -> applyApprovals
             (each wraps tool.executor via wrapExecutor; transport label preserved)
          9. getPattern(spec.pattern)(ctx)              -> open-registry dispatch; deep's adapter injects PLAN_TOOLS
         10. wrapDurableAgent if spec.execution.mode === 'durable'  -> runs invoke inside AGENT_WORKFLOW step.do
      agent.invoke({ messages, threadId })   or   agent.streamEvents(...)
        react loop:
          session = sessionStore.open(threadId ?? '')
          messages = await strategy.render(session, input.messages, { systemPrompt, model })
              -> full_replay: [system, ...all-events-as-messages, ...incoming]
              -> windowed:N:  [system, ...last-N-events, ...incoming]
              -> summarizing:N: [system, synthetic-summary, ...last-N-events, ...incoming]
                                (summary cached as kind='audit' event with metadata.covers_to_seq)
              -> semantic:N:   [system, ...BGE top-N by relevance, ...anchors, ...incoming]
          if toolsRetrieval.enabled: tools = selectTopKTools(tools, messages, toolsRetrieval)
          checkPreflightTokenBudget(...)                -> deny early if Anthropic count_tokens projects breach
          checkTokenBudget(limits, manifestId)          -> deny when cumulative spend already over cap
          model.chat / model.streamChat                 -> AI Gateway / Workers AI
              streamChat is an AsyncGenerator<string, ModelChatResult>:
              text deltas yield; the final result (with tool_calls + usage)
              is the generator's return value, captured via `await iter.next()`
              once `done === true` (no second non-stream call).
          recordUsage(result) -> LimitState.tokens.{input,output} += usage
          if tool_calls:
            for each call: tool.executor.execute(args, ctx)   -> governance-wrapped, transport-routed
              wrapped with withSpan(name='tool.call', attrs={ transport, tool, manifest_id })
              audit events fan out via AUDIT_QUEUE
              limit state increments
              if output.length > spec.artifacts.threshold_chars: spill to R2, return stub
              if ToolError thrown: stringified as [tool error/<code>] for the model
            persistFireAndForget(session, newEvents)     (fire-and-forget via execCtx.waitUntil)
            loop
          else: return final
```

## DO topology summary

```
ConversationDO   key: ${tenantId}:${threadSuffix}      transcript per thread
A2ATaskDO        key: ${tenantId}#${taskId}            task lifecycle per A2A task
ApprovalsDO      key: ${tenantId}#${approvalId}        critical section for decide writes
FederationDO     key: 'singleton'                       active PolicyBundle cache
```

Every DO key is tenant-prefixed (or singleton for federation), so cross-tenant probes cannot reach another tenant's state.
