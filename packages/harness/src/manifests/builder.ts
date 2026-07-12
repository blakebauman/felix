/**
 * Compile a Manifest into a runnable Agent.
 *
 *  1. Load + validate (Zod + cross-field rules from the pattern registry)
 *  2. Resolve system prompt (soul / inline / base)
 *  3. Resolve `SessionStore` + `SessionStrategy`
 *  4. Compose skills (tools / MCP / peers / prompt sections)
 *  5. Bind external MCP servers (namespaced)         → `McpExecutor`
 *  6. Build A2A peer tools                            → `A2AExecutor`
 *  7. Build container-backed tools                    → `ContainerExecutor`
 *  8. Build queue-backed tools                        → `QueueExecutor`
 *  9. Resolve sub-agents (multi-agent) or tools (single-agent);
 *     auto-inject memory tools when `memory.store` is Vectorize-backed.
 *     Pattern-specific tool injection (e.g. `PLAN_TOOLS` for `deep`)
 *     lives inside the pattern's registered adapter, not here.
 * 10. Governance pipeline: `mergeWithManifest` → `applyPolicies`
 *     → `applyLimits` → `applyGuardrails` → `applyApprovals`.
 *     Each wrapper replaces `tool.executor` via `wrapExecutor(...)` so
 *     the inner `transport` label survives.
 * 11. Hand off to pattern builder (open registry dispatch) → `Agent`
 *
 * The dependency on env / auth comes through `BuildDeps` rather than module
 * globals so unit tests construct a fresh provider + env per case.
 */

import { makePeerTool } from '../a2a/client';
import { applyApprovals } from '../approvals/wrap';
import type { AuthContext } from '../auth/context';
import { getContext } from '../context';
import type { Env } from '../env';
import { applyJudges } from '../guardrails/judge-wrap';
import { guardrailsEnabled, judgesEnabled } from '../guardrails/models';
import { applyGuardrails } from '../guardrails/wrap';
import { anyLimit } from '../limits/models';
import { applyLimits } from '../limits/wrap';
import { bindExternalMcp } from '../mcp/client';
import { recallProcedureTool } from '../memory/procedural';
import { memoryTools } from '../memory/tools';
import { recordCounter } from '../observability/metrics';
import { manifestSpan } from '../observability/tracing';
import { fetchArtifactTool } from '../tools/artifacts';
import { makeBrowserTool } from '../tools/browser-executor';
import { makeContainerTool } from '../tools/container-executor';
import { makeQueueTool } from '../tools/queue-executor';
import { makeSandboxTool } from '../tools/sandbox-executor';
import type { AgentWorkflowParams } from '../workflows/types';
// Side-effect imports — each pattern self-registers in the pattern registry.
// Adding a new built-in pattern is one more import line here.
import '../patterns/deep';
import '../patterns/groupchat';
import '../patterns/parallel';
import '../patterns/plan-execute';
import '../patterns/react';
import '../patterns/reflect';
import '../patterns/router';
import { getPattern, listPatterns } from '../patterns/registry';
import type { Agent, InvokeInput, InvokeResult, StreamEvent } from '../patterns/types';
import { mergeWithManifest } from '../policy/bundle';
import { ensureFederationSynced } from '../policy/federation-do';
import { applyPolicies } from '../policy/wrap';
import { getSessionStore } from '../session/do-session';
import { getSessionStrategy } from '../session/strategies';
import { getActivated } from '../skills/activation-store';
import { getSkillMeta, loadSkillBody } from '../skills/loader';
import type { ToolProvider } from '../tools/provider';
import type { Tool } from '../tools/types';
import { loadManifest } from './loader';
import type { A2APeerRef, Manifest } from './schema';
import { validateManifest } from './validate';

export interface BuildDeps {
  env: Env;
  tools: ToolProvider;
  auth?: AuthContext;
  soulLoader?: (tenantId: string) => Promise<string> | string;
  extraTools?: Tool[];
  subAgentBuilder?: (name: string) => Promise<Agent>;
}

export async function buildAgent(
  manifestOrName: Manifest | string,
  deps: BuildDeps,
): Promise<Agent> {
  const manifest =
    typeof manifestOrName === 'string' ? loadManifest(manifestOrName) : manifestOrName;
  validateManifest(manifest);

  const span = manifestSpan(manifest.metadata.name, manifest.metadata.version);
  try {
    const basePrompt = await resolveSystemPrompt(manifest, deps);

    // Resolve mcp / peer name lists from the manifest before skill composition.
    let mcpNames = manifest.spec.mcp_servers.map((m) => m.name);
    let peerNames = manifest.spec.peers.map((p) => p.name);

    // Per-tenant skill activation overlay.
    let activeSkillNames: Set<string> | null = null;
    if (deps.auth?.principal.tenantId) {
      const overlay = await getActivated(
        deps.env,
        deps.auth.principal.tenantId,
        manifest.metadata.name,
      );
      if (overlay !== null) activeSkillNames = new Set(overlay);
    }

    const {
      toolIds,
      systemPrompt,
      mcpNames: mergedMcp,
      peerNames: mergedPeers,
    } = composeSkills(manifest, {
      baseToolIds: manifest.spec.tools,
      basePrompt,
      baseMcpNames: mcpNames,
      basePeerNames: peerNames,
      activeSkillNames,
    });
    mcpNames = mergedMcp;
    peerNames = mergedPeers;

    const authHeaderProvider = deps.auth
      ? async (target: { name?: string; auth?: string; url?: string }) =>
          deps.auth!.outboundToken(target)
      : undefined;

    // Bind external MCP servers.
    const mcpTools: Tool[] = [];
    for (const ref of manifest.spec.mcp_servers) {
      try {
        const bound = await bindExternalMcp(ref, deps.env, authHeaderProvider);
        mcpTools.push(...bound);
      } catch (err) {
        console.warn(`MCP bind failed: ${ref.name}`, err);
      }
    }

    const manifestPeerByName = new Map<string, A2APeerRef>(
      manifest.spec.peers.map((p) => [p.name, p]),
    );
    for (const skillPeer of peerNames) {
      if (!manifestPeerByName.has(skillPeer)) {
        console.warn(
          `manifest ${manifest.metadata.name} — skill peer '${skillPeer}' has no A2APeerRef; skipping.`,
        );
      }
    }
    const peerTools = manifest.spec.peers.map((p) => makePeerTool(p, deps.env, authHeaderProvider));

    // Container-backed tools — each entry becomes a `Tool` whose executor
    // is a `ContainerExecutor` (`transport: container`). Auth lookup goes
    // through the same broker that MCP / A2A use, so raw tokens never
    // leak into the executor closure.
    const containerTools = manifest.spec.containers.map((c) =>
      makeContainerTool(c, deps.env, authHeaderProvider),
    );

    // Queue-backed tools — async transport, resolved via session.wake() +
    // tasks/resubscribe. The binding lookup fails the build if a manifest
    // references a queue producer that wasn't configured in wrangler.jsonc.
    const queueTools = manifest.spec.queues.map((q) =>
      makeQueueTool(q, deps.env, manifest.metadata.name),
    );

    // Sandbox-backed tools — sixth transport, talks to a worker-local
    // Fetcher (Service binding or DO-stub adapter). Same fail-fast
    // pattern as queues: a missing binding fails the build.
    const sandboxTools = manifest.spec.sandboxes.map((s) =>
      makeSandboxTool(s, deps.env as unknown as Record<string, unknown>),
    );

    // Browser-Rendering-backed tools — seventh transport, also Fetcher-
    // shaped. Each entry routes a fixed op (`content` / `links` /
    // `snapshot` / `screenshot` / `pdf` / `json`) on the wrapper Worker.
    const browserTools = manifest.spec.browser_tools.map((b) =>
      makeBrowserTool(b, deps.env as unknown as Record<string, unknown>),
    );

    // -------------------------------------------------------------------
    // Resolve sub-agents (multi-agent patterns) and tools (everyone else).
    // The pattern adapter picks which it cares about — sub-agent-only
    // patterns get an empty `tools` list (governance pipeline below is a
    // no-op on an empty list).
    // -------------------------------------------------------------------
    const subAgents: Record<string, Agent> = {};
    if (manifest.spec.sub_agents.length) {
      const builder = deps.subAgentBuilder ?? (async (name: string) => buildAgent(name, deps));
      for (const name of manifest.spec.sub_agents) {
        subAgents[name] = await builder(name);
      }
    }

    let resolvedTools = manifest.spec.sub_agents.length ? [] : deps.tools.resolve(toolIds);

    // Auto-inject memory tools when the manifest opts into Vectorize-backed
    // semantic memory — the agent gets `memory_remember` + `memory_recall`
    // without authoring them in the manifest.
    const memMode = manifest.spec.memory.store;
    if (memMode === 'vectorize' || memMode === 'agentcore') {
      const seen = new Set(resolvedTools.map((t) => t.name));
      for (const t of memoryTools(manifest.metadata.name)) {
        if (!seen.has(t.name)) {
          resolvedTools.push(t);
          seen.add(t.name);
        }
      }
    }

    if (mcpTools.length) {
      const seen = new Set(resolvedTools.map((t) => t.name));
      for (const t of mcpTools) if (!seen.has(t.name)) resolvedTools.push(t);
    }
    if (peerTools.length) {
      const seen = new Set(resolvedTools.map((t) => t.name));
      for (const t of peerTools) if (!seen.has(t.name)) resolvedTools.push(t);
    }
    if (containerTools.length) {
      const seen = new Set(resolvedTools.map((t) => t.name));
      for (const t of containerTools) if (!seen.has(t.name)) resolvedTools.push(t);
    }
    if (queueTools.length) {
      const seen = new Set(resolvedTools.map((t) => t.name));
      for (const t of queueTools) if (!seen.has(t.name)) resolvedTools.push(t);
    }
    if (sandboxTools.length) {
      const seen = new Set(resolvedTools.map((t) => t.name));
      for (const t of sandboxTools) if (!seen.has(t.name)) resolvedTools.push(t);
    }
    if (browserTools.length) {
      const seen = new Set(resolvedTools.map((t) => t.name));
      for (const t of browserTools) if (!seen.has(t.name)) resolvedTools.push(t);
    }
    // Auto-inject `recall_procedure` when procedural memory is enabled.
    if (manifest.spec.procedural_memory.enabled) {
      const seen = new Set(resolvedTools.map((t) => t.name));
      const tool = recallProcedureTool({
        enabled: manifest.spec.procedural_memory.enabled,
        top_k: manifest.spec.procedural_memory.top_k,
        embedding_model: manifest.spec.procedural_memory.embedding_model,
      });
      if (!seen.has(tool.name)) resolvedTools.push(tool);
    }
    // Auto-inject `fetch_artifact` when artifact spill is enabled.
    // The model has to be able to read back what the harness spilled
    // for it; without this tool the stub is a dead-end.
    if (manifest.spec.artifacts.enabled) {
      const seen = new Set(resolvedTools.map((t) => t.name));
      const tool = fetchArtifactTool({
        enabled: manifest.spec.artifacts.enabled,
        threshold_chars: manifest.spec.artifacts.threshold_chars,
        preview_chars: manifest.spec.artifacts.preview_chars,
        default_window_chars: manifest.spec.artifacts.default_window_chars,
        max_window_chars: manifest.spec.artifacts.max_window_chars,
      });
      if (!seen.has(tool.name)) resolvedTools.push(tool);
    }
    if (deps.extraTools?.length) {
      const seen = new Set(resolvedTools.map((t) => t.name));
      for (const t of deps.extraTools) if (!seen.has(t.name)) resolvedTools.push(t);
    }

    // -------------------------------------------------------------------
    // Governance pipeline: policies → limits → guardrails → approvals
    // -------------------------------------------------------------------
    // Mirror the FederationDO's active bundle into this isolate before
    // merging so centrally-distributed policies actually apply. Without this
    // the module-level `activeBundle` stays null in every request isolate and
    // `mergeWithManifest` enforces nothing. TTL-throttled — cheap to call per
    // build.
    await ensureFederationSynced(deps.env);
    const merged = mergeWithManifest(manifest.spec.policies, manifest.spec.approvals);

    if (merged.policies.length) {
      resolvedTools = applyPolicies(resolvedTools, merged.policies, manifest.metadata.name);
    }
    if (anyLimit(manifest.spec.limits)) {
      resolvedTools = applyLimits(resolvedTools, manifest.spec.limits, manifest.metadata.name);
    }
    if (guardrailsEnabled(manifest.spec.guardrails)) {
      resolvedTools = applyGuardrails(
        resolvedTools,
        manifest.spec.guardrails,
        manifest.metadata.name,
      );
    }
    // Judges run after the regex-style guardrails — a tool result that
    // escapes a `pii` filter can still be denied for being off-topic or
    // hallucinated. Both share the `guardrails` deny source so a
    // downstream consumer sees one consistent failure class.
    if (judgesEnabled(manifest.spec.guardrails)) {
      resolvedTools = applyJudges(resolvedTools, manifest.spec.guardrails, manifest.metadata.name);
    }
    if (merged.approvals.length) {
      resolvedTools = applyApprovals(resolvedTools, merged.approvals, manifest.metadata.name);
    }

    const finalPrompt =
      systemPrompt ||
      `You are ${manifest.metadata.name}. Use your tools when needed to answer accurately.`;

    const sessionStore = getSessionStore(deps.env, manifest.spec.memory.checkpointer);
    const sessionStrategy = getSessionStrategy(manifest.spec.session.strategy);

    // -------------------------------------------------------------------
    // Pattern dispatch through the open registry.
    // -------------------------------------------------------------------
    const patternBuilder = getPattern(manifest.spec.pattern);
    if (!patternBuilder) {
      throw new Error(
        `Unknown pattern '${manifest.spec.pattern}' for manifest '${manifest.metadata.name}' — registered patterns: ${listPatterns().join(', ') || '(none)'}.`,
      );
    }
    const baseAgent = await patternBuilder({
      env: deps.env,
      manifest,
      modelSpec: manifest.spec.model,
      tools: resolvedTools,
      subAgents,
      systemPrompt: finalPrompt,
      manifestId: manifest.metadata.name,
      manifestVersion: manifest.metadata.version,
      recursionLimit: manifest.spec.recursion_limit,
      maxTurns: manifest.spec.max_turns,
      aggregatorPrompt: manifest.spec.aggregator_prompt,
      classifierPrompt: finalPrompt,
      sessionStore,
      sessionStrategy,
      limits: manifest.spec.limits,
    });

    // Durable execution wrap: when `spec.execution.mode = 'durable'`,
    // every invocation lands as a Cloudflare Workflow instance instead
    // of running in the request isolate. The wrap is binding-graceful
    // — when `AGENT_WORKFLOW` is absent (unit tests, dev probes that
    // haven't wired the binding) it logs a counter and falls through to
    // the in-isolate agent so the test path keeps working.
    if (manifest.spec.execution.mode === 'durable') {
      return wrapDurableAgent(baseAgent, deps.env, manifest.metadata.name);
    }
    return baseAgent;
  } finally {
    span.end();
  }
}

const DURABLE_POLL_INTERVAL_MS = 250;

/**
 * Wrap an in-isolate `Agent` so each invocation creates a
 * `AgentWorkflow` instance and polls until the instance reaches a
 * terminal state. The output of the workflow is the inner agent's
 * `InvokeResult` — round-tripped through Workflow params/output so a
 * worker eviction mid-run replays the step rather than losing it.
 *
 * Falls through to the inner agent when `env.AGENT_WORKFLOW` is absent.
 *
 * Exported for unit tests; production callers reach this path through
 * `buildAgent` when `spec.execution.mode === 'durable'`.
 */
export function wrapDurableAgent(inner: Agent, env: Env, manifestId: string): Agent {
  return {
    tools: inner.tools,
    pattern: `durable:${inner.pattern}`,
    manifestId: inner.manifestId,
    manifestVersion: inner.manifestVersion,

    async invoke(input: InvokeInput): Promise<InvokeResult> {
      const binding = env.AGENT_WORKFLOW;
      if (!binding) {
        console.warn(
          `manifest '${manifestId}' declared execution.mode=durable but AGENT_WORKFLOW binding is absent — falling back to in-isolate invocation`,
        );
        recordCounter('orchestrator_durable_fallback', { manifest_id: manifestId });
        return inner.invoke(input);
      }
      const reqCtx = getContext();
      const tenantId = reqCtx?.auth.principal.tenantId ?? 'default';
      const principalSubject = reqCtx?.auth.principal.subject ?? '';
      const params: AgentWorkflowParams = {
        tenantId,
        principalSubject,
        manifestId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        messages: [...input.messages],
      };
      const instance = await binding.create({ params });
      recordCounter('orchestrator_durable_started', { manifest_id: manifestId });

      const callerSignal = reqCtx?.limitState.abortController.signal;
      while (true) {
        if (callerSignal?.aborted) {
          throw new Error('durable invocation cancelled by request-scope abort');
        }
        const status = await instance.status();
        if (status.status === 'complete') {
          recordCounter('orchestrator_durable_complete', {
            manifest_id: manifestId,
            status: 'complete',
          });
          // The workflow returns a JSON-encoded `InvokeResult` — parse
          // it back. The encode/decode pair handles the structural
          // mismatch between `Serializable<T>` and our recursive
          // message shapes.
          return JSON.parse(status.output as string) as InvokeResult;
        }
        if (status.status === 'errored' || status.status === 'terminated') {
          recordCounter('orchestrator_durable_complete', {
            manifest_id: manifestId,
            status: status.status,
          });
          throw new Error(
            `workflow ${status.status}: ${status.error?.message ?? 'no error message'}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, DURABLE_POLL_INTERVAL_MS));
      }
    },

    async *streamEvents(input: InvokeInput): AsyncGenerator<StreamEvent> {
      // v1 streaming: drive the durable invocation to completion and
      // emit one terminal event. Streaming token deltas off a workflow
      // requires per-step SSE relay — follow-on work.
      const result = await this.invoke(input);
      yield { event: 'on_chain_end', data: { output: result } };
    },
  };
}

async function resolveSystemPrompt(manifest: Manifest, deps: BuildDeps): Promise<string> {
  const sp = manifest.spec.system_prompt;
  const parts: string[] = [];
  if (sp.soul && deps.soulLoader && deps.auth) {
    try {
      parts.push(await deps.soulLoader(deps.auth.principal.tenantId));
    } catch {
      // ignore soul loader failures — missing soul falls back to base/inline
    }
  }
  if (sp.base) parts.push(sp.base);
  if (sp.inline) parts.push(sp.inline);
  return parts.filter(Boolean).join('\n\n---\n\n');
}

interface ComposeSkillInputs {
  baseToolIds: string[];
  basePrompt: string;
  baseMcpNames: string[];
  basePeerNames: string[];
  activeSkillNames: Set<string> | null;
}

interface ComposeSkillOutputs {
  toolIds: string[];
  systemPrompt: string;
  mcpNames: string[];
  peerNames: string[];
}

function composeSkills(manifest: Manifest, inputs: ComposeSkillInputs): ComposeSkillOutputs {
  const toolIds = [...inputs.baseToolIds];
  const mcpNames = [...inputs.baseMcpNames];
  const peerNames = [...inputs.basePeerNames];
  const seenTools = new Set(toolIds);
  const seenMcp = new Set(mcpNames);
  const seenPeers = new Set(peerNames);
  const promptSections: string[] = [];

  for (const ref of manifest.spec.skills) {
    if (inputs.activeSkillNames && !inputs.activeSkillNames.has(ref.name)) continue;
    const spec = getSkillMeta(ref.name);
    if (!spec) {
      console.warn(
        `manifest ${manifest.metadata.name} declares skill '${ref.name}' but it is not bundled.`,
      );
      continue;
    }
    for (const t of spec.tools ?? []) {
      if (!seenTools.has(t)) {
        seenTools.add(t);
        toolIds.push(t);
      }
    }
    for (const m of spec.mcp_servers ?? []) {
      if (!seenMcp.has(m)) {
        seenMcp.add(m);
        mcpNames.push(m);
      }
    }
    for (const p of spec.peers ?? []) {
      if (!seenPeers.has(p)) {
        seenPeers.add(p);
        peerNames.push(p);
      }
    }
    const body = loadSkillBody(ref.name).trim();
    if (body) promptSections.push(`## Skill: ${spec.name}\n\n${body}`);
  }

  let systemPrompt = inputs.basePrompt;
  if (promptSections.length) {
    const suffix = `\n\n---\n## Active Skills\n\n${promptSections.join('\n\n')}`;
    systemPrompt = systemPrompt ? systemPrompt + suffix : suffix.replace(/^\n+/, '');
  }
  return { toolIds, systemPrompt, mcpNames, peerNames };
}
