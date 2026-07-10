/**
 * Cross-field validation:
 *   - apiVersion / kind sentinels
 *   - multi-agent patterns (`kind: 'multi-agent'` in the pattern registry)
 *     require `sub_agents` and forbid `peers`
 *   - `sub_agents` is forbidden on non-multi-agent patterns
 *   - `aggregator_prompt` is parallel-only
 *   - tool / skill name existence checks against an optional registry
 *
 * Multi-agent semantics come from `isMultiAgentPattern` in the pattern
 * registry — so a deployment that registers a new multi-agent pattern
 * via `registerPattern(name, build, { kind: 'multi-agent' })` gets the
 * constraint enforcement automatically.
 */

import { isMultiAgentPattern } from '../patterns/registry';
import { API_VERSION, MANIFEST_KIND, type Manifest } from './schema';

export class ManifestValidationError extends Error {}

export function validateManifest(
  manifest: Manifest,
  opts: {
    registeredToolNames?: Iterable<string>;
    knownSkillNames?: Iterable<string>;
  } = {},
): void {
  if (manifest.apiVersion !== API_VERSION) {
    throw new ManifestValidationError(
      `Unsupported apiVersion '${manifest.apiVersion}' (expected '${API_VERSION}')`,
    );
  }
  if (manifest.kind !== MANIFEST_KIND) {
    throw new ManifestValidationError(
      `Unsupported kind '${manifest.kind}' (expected '${MANIFEST_KIND}')`,
    );
  }

  const spec = manifest.spec;
  const multiAgent = isMultiAgentPattern(spec.pattern);

  if (multiAgent) {
    if (spec.peers.length > 0) {
      throw new ManifestValidationError(
        `pattern=${spec.pattern} is mutually exclusive with peers=[...] — multi-agent patterns supervise in-process children; peers are A2A delegates.`,
      );
    }
    if (spec.containers.length > 0) {
      throw new ManifestValidationError(
        `pattern=${spec.pattern} is mutually exclusive with containers=[...] — multi-agent patterns dispatch to children; tools (including container-backed ones) belong on the leaf manifests.`,
      );
    }
    if (spec.queues.length > 0) {
      throw new ManifestValidationError(
        `pattern=${spec.pattern} is mutually exclusive with queues=[...] — multi-agent patterns dispatch to children; queue-backed tools belong on the leaf manifests.`,
      );
    }
    if (spec.sandboxes.length > 0) {
      throw new ManifestValidationError(
        `pattern=${spec.pattern} is mutually exclusive with sandboxes=[...] — multi-agent patterns dispatch to children; sandbox-backed tools belong on the leaf manifests.`,
      );
    }
    if (spec.browser_tools.length > 0) {
      throw new ManifestValidationError(
        `pattern=${spec.pattern} is mutually exclusive with browser_tools=[...] — multi-agent patterns dispatch to children; browser-backed tools belong on the leaf manifests.`,
      );
    }
    if (spec.sub_agents.length === 0) {
      throw new ManifestValidationError(
        `pattern=${spec.pattern} requires sub_agents=[...] listing the in-process agent manifests to dispatch to.`,
      );
    }
  }

  if (!multiAgent && spec.sub_agents.length > 0) {
    throw new ManifestValidationError(
      `sub_agents is only valid for multi-agent patterns (got pattern='${spec.pattern}')`,
    );
  }

  if (spec.aggregator_prompt && spec.pattern !== 'parallel') {
    throw new ManifestValidationError(
      `aggregator_prompt is only valid for pattern=parallel (got pattern='${spec.pattern}')`,
    );
  }

  if (spec.pattern === 'plan_execute') {
    if (spec.tools.length === 0 && spec.peers.length === 0 && spec.containers.length === 0) {
      throw new ManifestValidationError(
        "pattern=plan_execute is pointless without tools — declare tools[], peers[], or containers[] for the executor to drive. Use pattern='react' for plain chat.",
      );
    }
  }

  if (spec.execution.mode === 'durable') {
    if (multiAgent) {
      throw new ManifestValidationError(
        `execution.mode=durable is only valid for single-agent patterns; pattern=${spec.pattern} dispatches to sub-agents whose own durability is set on their leaf manifests.`,
      );
    }
    if (spec.memory.checkpointer === 'none') {
      throw new ManifestValidationError(
        `execution.mode=durable requires a checkpointed memory.checkpointer (got 'none') — a durable workflow without a session log cannot resume mid-conversation.`,
      );
    }
  }

  if (opts.registeredToolNames) {
    const known = new Set(opts.registeredToolNames);
    const unknown = spec.tools.filter((t) => !known.has(t));
    if (unknown.length) {
      throw new ManifestValidationError(
        `Manifest '${manifest.metadata.name}' references unregistered tools: ${JSON.stringify(unknown.sort())}`,
      );
    }
  }

  if (opts.knownSkillNames) {
    const known = new Set(opts.knownSkillNames);
    const missing = spec.skills.map((s) => s.name).filter((n) => !known.has(n));
    if (missing.length) {
      throw new ManifestValidationError(
        `Manifest '${manifest.metadata.name}' references unknown skills: ${JSON.stringify(missing.sort())}`,
      );
    }
  }
}
