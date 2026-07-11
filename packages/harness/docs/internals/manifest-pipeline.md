---
description: "The buildAgent compile step — validation, tool binding, governance wrapping, pattern dispatch, and durable execution wrapping."
---

# Manifest Pipeline

How `buildAgent(manifest, deps)` turns a parsed manifest into a runnable `Agent`. Source: `src/manifests/builder.ts`.

## BuildDeps

```ts
interface BuildDeps {
  env: Env;
  tools: ToolProvider;
  auth?: AuthContext;
  soulLoader?: (tenantId: string) => Promise<string> | string;
  extraTools?: Tool[];
  subAgentBuilder?: (name: string) => Promise<Agent>;
}
```

Routes pass `{ env, tools }` (and `auth` for paths that need per-tenant skill activation). `subAgentBuilder` is an injection point primarily used by tests to stub sub-agents in multi-agent patterns.

## The steps

### 1. Load and validate

```ts
const manifest = typeof manifestOrName === 'string' ? loadManifest(manifestOrName) : manifestOrName;
validateManifest(manifest);
```

`loadManifest` reads from `BUNDLED_MANIFESTS` (sync) with an in-memory cache — `buildAgent` always uses the bundled fallback when handed a bare name. Request-path code resolves the manifest **before** calling `buildAgent`, via `resolveManifest(env, tenantId, name)` (`src/manifests/resolver.ts`), which walks tenant D1 → tenant R2 → global R2 → bundled. The route then passes the resolved `Manifest` object into `buildAgent`, so the builder itself stays tenant-unaware. `validateManifest` re-applies the Zod schema and runs cross-field checks: `apiVersion` constant, `kind` constant, single-agent vs multi-agent constraints, `aggregator_prompt` only for parallel.

A `manifestSpan(name, version)` opens here for observability and closes in the `finally` block at the end.

### 2. Resolve the system prompt

`resolveSystemPrompt` (`src/manifests/builder.ts`). Joined with `"\n\n---\n\n"` in this order:

1. **soul** — `await deps.soulLoader(tenantId)` if `system_prompt.soul: true` and a `soulLoader` is supplied. Failures are swallowed so a missing soul falls back to the rest.
2. **base** — `system_prompt.base`
3. **inline** — `system_prompt.inline`

Empty parts are filtered out. The result is the **base prompt**; skills will append below.

### 3. Resolve session + memory

Two parts:

- The `SessionStore` and `SessionStrategy` are resolved at step 9 (just before pattern dispatch) via `getSessionStore(env, memory.checkpointer)` and `getSessionStrategy(spec.session.strategy)`. Checkpointer aliases `agentcore` / `sqlite` map to `do`; `none` returns a no-op store. Strategy spec accepts `full_replay` (default), `windowed:N`, `summarizing:N`, `semantic:N` — see [internals/patterns.md](patterns.md) and [persistence.md](persistence.md).
- The long-term `memory.store` is checked here to know whether to auto-inject memory tools later. `vectorize` (default) and `agentcore` (alias) both opt in.

### 4. Compose skills

`composeSkills` (`src/manifests/builder.ts`).

For each `SkillRef`:

1. If a per-tenant activation overlay exists and excludes this skill, skip it.
2. Load metadata via `getSkillMeta(name)`. If missing from the bundle, warn and skip.
3. Fold the skill's frontmatter `tools`, `mcp_servers`, `peers` into the running deduped sets.
4. Append the skill body to `promptSections` under a `## Skill: <name>` header.

When at least one skill contributed prompt content, the joined sections are prepended with `\n\n---\n## Active Skills\n\n` and concatenated onto the base prompt.

Per-tenant activation comes from `getActivated(env, tenantId, manifestId)` in `src/skills/activation-store.ts` (table `skill_activation`):

- `null` — no overlay, all declared skills active.
- `[]` — empty overlay, nothing active.
- `[a, b]` — only this subset active. The overlay can never add a skill not declared by the manifest.

### 5. Bind external MCP servers

For each `manifest.spec.mcp_servers[]`:

```ts
const bound = await bindExternalMcp(ref, deps.env, authHeaderProvider);
mcpTools.push(...bound);
```

`bindExternalMcp` (`src/mcp/client.ts`) runs `assertSafeOutboundUrlForEnv` (SSRF), calls the server's `tools/list`, and wraps each remote tool in a `Tool` namespaced as `${server.name}__${remoteToolName}`. Each remote tool carries an `McpExecutor` (`transport: 'mcp'`) — the model loop sees `tool.executor.execute(args, ctx)` and the executor handles the JSON-RPC `tools/call` round-trip, auth header lookup, and abort-signal propagation. The remote `inputSchema` survives through the `rawInputSchema` escape hatch on `Tool` — `getToolInputSchema(tool)` (in `src/patterns/zod-to-json-schema.ts`) returns it verbatim to the LLM instead of synthesizing one from a generic Zod placeholder.

Bind failures are logged and don't fail the build — a manifest can declare an MCP server that's currently unreachable and the rest of the agent still works.

### 6. Build A2A peer tools

```ts
const peerTools = manifest.spec.peers.map((p) => makePeerTool(p, deps.env, authHeaderProvider));
```

`makePeerTool` (`src/a2a/client.ts`) returns a tool named `peer_${ref.name}` with `isPeer: true` and an `A2AExecutor` (`transport: 'a2a'`). The name prefix and the flag both signal the limits wrapper to count this invocation against `peerHops`.

Skill-declared peers that don't have a matching `A2APeerRef` in the manifest are warned and skipped — the peer tool can't be constructed without a URL.

`authHeaderProvider` is wired to `deps.auth.outboundToken(target)` when an auth context is present; outbound peer/MCP/container calls get the resolved `Authorization` header.

### 6b. Build container tools

```ts
const containerTools = manifest.spec.containers.map((c) =>
  makeContainerTool(c, deps.env, authHeaderProvider),
);
```

`makeContainerTool` (`src/tools/container-executor.ts`) returns a tool whose executor is a `ContainerExecutor` (`transport: 'container'`) pointing at the declared gateway. The inward Zod schema is permissive (`record(unknown)`) — when the manifest declares `args_schema`, it is advertised verbatim to the model through `rawInputSchema`; the gateway is responsible for input validation.

The auth indirection is the same as MCP / A2A: when `containers[].auth` is set, the executor asks the broker (`AuthContext.outboundToken({ name, auth, url })`) for an `Authorization` header on each call. The raw token never enters the executor's closure.

Containers are forbidden when `pattern ∈ {router, parallel, groupchat}` (enforced in `validate.ts`) — multi-agent patterns dispatch to children; tools belong on the leaves.

### 6c. Build queue-backed (async) tools

```ts
const queueTools = manifest.spec.queues.map((q) =>
  makeQueueTool(q, deps.env, manifest.metadata.name),
);
```

`makeQueueTool` (`src/tools/queue-executor.ts`) resolves the `queue_binding` against `env[binding]` and wraps the resulting `Queue` in a `QueueExecutor` (`transport: 'queue'`). A missing binding throws at build time so a misconfigured manifest never silently no-ops at request time. The inward Zod schema is permissive; declared `args_schema` is advertised verbatim through `rawInputSchema`.

Async path: `execute()` enqueues a `QueueJobMessage` (`{ job_id, thread_id, tool_call_id, tool, tenant_id, manifest_id, arguments, deadline_ms? }`), emits a `queue_dispatch` audit, and returns a chatty `[queued]` stub mentioning `job_id` + `tasks/resubscribe`. The consumer (a separate Worker reading from the same queue) does the work and POSTs the `tool_result` back through `POST /internal/sessions/:thread_id/events`. The endpoint forwards to `ConversationDO` and emits `queue_complete` server-side. When the client reconnects via `tasks/resubscribe`, `session.wake()` reports the cycle resolved and the next model step renders the resolved cycle.

Orphan path: a cron sweep (`src/jobs/queue-orphan-cleanup.ts`) writes a synthetic `[expired]` `tool_result` for any `queue_dispatch` older than 30m without a paired `queue_complete` / `queue_expired`, so the cycle can resolve even when the consumer is unreachable.

Queues are forbidden when `pattern ∈ {router, parallel, groupchat}`, same rule as containers and peers.

### 6d. Build sandbox tools

```ts
const sandboxTools = manifest.spec.sandboxes.map((s) =>
  makeSandboxTool(s, deps.env),
);
```

`makeSandboxTool` (`src/tools/sandbox-executor.ts`) resolves the `binding` against `env[binding]` and wraps it in a `SandboxExecutor` (`transport: 'sandbox'`). The sandbox binding is a Service binding pointing at a separate Worker that fronts the Cloudflare Sandbox SDK — Felix doesn't run the Sandbox SDK in-isolate. See `examples/sandbox-worker/` for the reference adapter (one ~150-line `fetch()` handler that maps `{op, code, files, ...}` to `getSandbox().exec()` / `.writeFile()` / `.startProcess()` / `.exposePort()`).

Op surface: `exec` (single command, returns stdout/stderr/exit_code), `write_file` / `read_file` / `delete_file`, `process_start` / `process_status` / `process_kill` (long-running daemons keyed by per-thread session), `expose_port` (returns a signed preview URL the model can hand to a user). All ops carry `session_id = ${tenant_id}:${thread_id}` so a sandbox is sticky per thread without manifest opt-in.

Sandboxes are forbidden when `pattern ∈ {router, parallel, groupchat}` — multi-agent patterns dispatch to children; tools belong on the leaves.

### 6e. Build browser tools

```ts
const browserTools = manifest.spec.browser_tools.map((b) =>
  makeBrowserTool(b, deps.env),
);
```

`makeBrowserTool` (`src/tools/browser-executor.ts`) wraps a Service-bound `Fetcher` in a `BrowserExecutor` (`transport: 'browser'`). The reference adapter at `examples/browser-worker/` bridges to `@cloudflare/puppeteer` over the Cloudflare Browser Rendering binding. Built-in ops: `content` (rendered HTML), `links` (deduped absolute hrefs), `snapshot` (`{html, screenshot_base64}`), `screenshot` (`data:image/png;base64,...`), `pdf` (`data:application/pdf;base64,...`), `json` (passthrough fetch that skips Chromium).

Browser tools are forbidden under multi-agent patterns for the same reason.

### 7. Resolve sub-agents and tools

Multi-agent patterns (`isMultiAgentPattern(spec.pattern)`) build their sub-agent map; everyone else resolves `tools[]` from the `ToolProvider`. The builder no longer takes a multi-agent early return — both branches feed the same `PatternBuildContext` at step 9, and each pattern adapter reads the field it cares about.

```ts
const subAgents: Record<string, Agent> = {};
if (manifest.spec.sub_agents.length) {
  const builder = deps.subAgentBuilder ?? (async (name) => buildAgent(name, deps));
  for (const name of manifest.spec.sub_agents) subAgents[name] = await builder(name);
}
let resolvedTools = manifest.spec.sub_agents.length ? [] : deps.tools.resolve(toolIds);
```

Auto-injection passes (each dedupes by name) on the single-agent branch:

1. **Memory tools** — if `memory.store ∈ {vectorize, agentcore}`, inject `memory_remember` and `memory_recall`.
2. **Procedural memory** — if `spec.procedural_memory.enabled`, inject `recall_procedure` (reads successful past plans from Vectorize index keyed by manifest).
3. **Artifact fetch** — if `spec.artifacts.enabled`, inject `fetch_artifact` (reads back an R2-spilled tool result by ref). Auto-injected because `react` spills above `threshold_chars` to keep the working set small.
4. **MCP tools, peer tools, container tools, queue tools, sandbox tools, browser tools, extraTools** — appended in that order.

`PLAN_TOOLS` injection for `pattern: deep` lives **inside `deep`'s registered pattern adapter** (`src/patterns/deep.ts`), not in the builder — so a new pattern with its own tool needs only registers its adapter and the builder stays unaware.

### 8. Governance pipeline

```ts
const merged = mergeWithManifest(manifest.spec.policies, manifest.spec.approvals);

if (merged.policies.length)                       resolvedTools = applyPolicies(resolvedTools, merged.policies, manifestId);
if (anyLimit(manifest.spec.limits))               resolvedTools = applyLimits(resolvedTools, manifest.spec.limits, manifestId);
if (guardrailsEnabled(manifest.spec.guardrails))  resolvedTools = applyGuardrails(resolvedTools, manifest.spec.guardrails, manifestId);
if (judgesEnabled(manifest.spec.guardrails))      resolvedTools = applyJudges(resolvedTools, manifest.spec.guardrails, manifestId);
if (merged.approvals.length)                      resolvedTools = applyApprovals(resolvedTools, merged.approvals, manifestId);
```

Each wrapper replaces `tool.executor` with a new `ToolExecutor` built via `wrapExecutor(inner.executor, ...)` — preserving the inner transport label (`local` / `mcp` / `a2a` / `container` / `queue` / `sandbox` / `browser`) so audit and observability can report the true transport even after governance composition.

`mergeWithManifest` (`src/policy/bundle.ts`) unions the manifest's policies with the active (Ed25519-verified) `PolicyBundle`'s. Bundle entries win on `id` collision. Bundle-side approvals have a permissive shape today, so manifest approvals are merged in but bundle approvals are not cross-merged.

Wrapper order matters — see [governance.md](governance.md) for the runtime stack semantics. From the model's perspective the wrappers compose outermost-first: a tool call passes through Approvals → LLM Judge → Guardrails → Limits → Policies → inner tool.

### 9. Pattern dispatch through the open registry

```ts
const sessionStore = getSessionStore(deps.env, manifest.spec.memory.checkpointer);
const sessionStrategy = getSessionStrategy(manifest.spec.session.strategy);
const patternBuilder = getPattern(manifest.spec.pattern);
if (!patternBuilder) throw new Error(`Unknown pattern '${manifest.spec.pattern}' — registered: ${listPatterns()}`);

let agent = await patternBuilder({
  env, manifest, modelSpec: manifest.spec.model,
  tools: resolvedTools, subAgents,
  systemPrompt: finalPrompt,
  manifestId, manifestVersion,
  recursionLimit: manifest.spec.recursion_limit,
  maxTurns: manifest.spec.max_turns,
  aggregatorPrompt: manifest.spec.aggregator_prompt,
  classifierPrompt: finalPrompt,
  sessionStore, sessionStrategy,
  limits: manifest.spec.limits,
});

if (manifest.spec.execution?.mode === 'durable') {
  agent = wrapDurableAgent(agent, deps.env, manifest.metadata.name);
}
return agent;
```

`limits` is the manifest's `spec.limits` block — it's threaded through so the pattern can run the pre-flight + cumulative token-budget checks (`checkPreflightTokenBudget` / `checkTokenBudget` from `src/limits/wrap.ts`) right before each model call. Router/parallel receive the same field for the same reason: the classifier and aggregator calls are also gated.

`PatternBuildContext` (`src/patterns/registry.ts`) carries no dedicated `toolsRetrieval` / `artifacts` fields — instead each adapter reads `ctx.manifest.spec.tools_retrieval` / `ctx.manifest.spec.artifacts` directly off the manifest it was handed. `tools_retrieval` enables JIT tool selection — the react loop filters its tool array via BGE cosine similarity against the conversation tail before each model call. `artifacts` enables R2-backed spilling of large tool results with an injected `fetch_artifact` tool.

Built-in pattern adapters live in `src/patterns/{react,deep,router,parallel,groupchat,reflect,plan-execute}.ts`; each calls `registerPattern(name, build, { kind })` at module bottom. Deployments can register additional patterns from `apps/api/src/composition.ts` without editing `builder.ts`. The pattern's `kind` (`single-agent` / `multi-agent`) is what `validate.ts` reads via `isMultiAgentPattern(name)` to enforce sub_agents / peers cross-field rules — register a new multi-agent pattern with `{ kind: 'multi-agent' }` and the validator picks up the constraints automatically.

### 10. Durable execution wrap

When `spec.execution.mode === 'durable'`, `wrapDurableAgent(agent, env, manifest.metadata.name)` (`src/manifests/builder.ts`) returns a `DurableAgent` whose `invoke` packs the request into a Workflow params object, calls `env.AGENT_WORKFLOW.create({ params })`, polls instance status, and parses the workflow's JSON-stringified return into an `InvokeResult`. The poll loop honors the request abort signal — if the request unwinds, the workflow keeps running and clients reconnect via A2A `tasks/resubscribe`. When `env.AGENT_WORKFLOW` is absent (dev probes, unit tests), the wrap logs an `orchestrator_durable_fallback` counter and delegates straight to the inner agent.

Cross-field validation rejects `execution.mode: durable` for multi-agent patterns (delegation through `step.do` inflates step count) and for `memory.checkpointer: none` (a durable workflow needs a persistent session log).

The returned `Agent` exposes `invoke()` and `streamEvents()` plus the resolved `tools` array (used by `/mcp` to expose the agent's tools to MCP clients).

## Caching

Inside each router (`chat.ts`, `openai-compat.ts`) the agent build is cached per resolved manifest:

```ts
const cache = new Map<string, Promise<Agent>>();
function getAgent(env: Env, resolved: ResolvedManifest): Promise<Agent> {
  let pending = cache.get(resolved.cacheKey);
  if (!pending) {
    pending = buildAgent(resolved.manifest, { env, tools: deps.tools });
    cache.set(resolved.cacheKey, pending);
  }
  return pending;
}
```

`ResolvedManifest.cacheKey` encodes the source + tenant + version (`tenant_d1:<tenant>#<name>#<version>`, `tenant_r2:<tenant>#<name>`, `global_r2:<name>`, `bundled:<name>`), so a tenant flipping their active pointer naturally builds a fresh agent on the next request instead of serving the stale build. The cache outlives a single request and is per isolate. Because `BuildDeps` doesn't include `auth` here, per-tenant skill activation overlays are picked up only at routes that pass `auth` through `BuildDeps` (currently `/a2a` and `/mcp` do, `/chat` and `/v1` do not by default).
