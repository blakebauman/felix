/**
 * /.well-known/agent-card.json builder.
 *
 * The card is the discovery document for an A2A peer: identity, supported
 * capabilities (mapped from a published manifest's a2a.capabilities), the
 * inbound auth schemes the manifest accepts, and a `federation` block so
 * peers can verify both sides are running the same governance bundle.
 */

import type { Manifest } from '../manifests/schema';
import { getActiveBundle } from '../policy/bundle';

export interface AgentCardContainer {
  name: string;
  description: string;
  image: string;
}

export interface AgentCardQueue {
  name: string;
  description: string;
}

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  protocols: string[];
  endpoints: { a2a: string; mcp?: string };
  auth: { schemes: string[]; required_scopes: string[]; allow_anonymous: boolean };
  capabilities: Array<{ id: string; description: string; input_schema_ref: string }>;
  /**
   * Container-backed tools surfaced for peer discovery. Lets a peer see
   * what sandboxes this agent exposes before deciding to call it. The
   * gateway URL is intentionally omitted — peers reach containers
   * indirectly through this agent's A2A surface, not by hitting the
   * gateway themselves.
   */
  containers: AgentCardContainer[];
  /**
   * Queue-backed async tools surfaced for peer discovery. Name +
   * description only — the binding name is internal infrastructure and
   * never leaks to peers (a peer calls these tools through A2A like any
   * other; this agent decides whether the dispatch goes through a queue).
   */
  queues: AgentCardQueue[];
  federation: { bundleVersion: string; issuer: string } | null;
}

export function buildAgentCard(
  manifest: Manifest,
  opts: { baseUrl: string; mcpEnabled: boolean },
): AgentCard {
  const bundle = getActiveBundle();
  return {
    name: manifest.metadata.name,
    description: manifest.metadata.description,
    version: manifest.metadata.version,
    protocols: ['a2a/jsonrpc/2.0', 'openai/chat/v1', 'mcp/sse'],
    endpoints: {
      a2a: `${opts.baseUrl}/a2a`,
      ...(opts.mcpEnabled ? { mcp: `${opts.baseUrl}/mcp` } : {}),
    },
    auth: {
      schemes: manifest.spec.auth.inbound.schemes,
      required_scopes: manifest.spec.auth.inbound.required_scopes,
      allow_anonymous: manifest.spec.auth.inbound.allow_anonymous,
    },
    capabilities: manifest.spec.a2a.capabilities.map((c) => ({
      id: c.id,
      description: c.description,
      input_schema_ref: c.input_schema_ref,
    })),
    containers: manifest.spec.containers.map((c) => ({
      name: c.name,
      description: c.description,
      image: c.image,
    })),
    queues: manifest.spec.queues.map((q) => ({
      name: q.name,
      description: q.description,
    })),
    federation: bundle ? { bundleVersion: bundle.version, issuer: bundle.issuer } : null,
  };
}
