/**
 * Manifest schema (Zod). Every object is `.strict()` so unknown keys are
 * rejected, and field defaults are frozen. `apiVersion` and `kind` are
 * validated as constants.
 *
 * Per-field `.openapi({ description })` calls mirror the prose reference
 * at `docs/guide/manifest-reference.md` so the Scalar UI at `/docs` is a
 * self-serve manifest authoring guide — keep the two in sync when fields
 * change.
 */

import { z } from '@hono/zod-openapi';
import { ApprovalRuleSchema } from '../approvals/models';
import { GuardrailsSchema } from '../guardrails/models';
import { ABSOLUTE_LIMITS, LimitsSchema } from '../limits/models';
import { PolicySchema } from '../policy/models';
import { assertSafeOutboundUrl } from '../security/ssrf';

export const API_VERSION = 'orchestrator/v1';
export const MANIFEST_KIND = 'Agent';

/**
 * Legal characters for a manifest name. The name is used verbatim as an R2
 * object-key segment in the resolver's override chain
 * (`manifests/<tenant>/<name>.json` and the global `manifests/<name>.json`),
 * so a `/` in the name lets a caller in tenant A address tenant B's
 * tenant-scoped override object via the global layer. Restricting to this
 * character class (no `/`, no whitespace, no `..` path tricks) closes that
 * cross-tenant path-confusion at the schema layer; `assertValidManifestName`
 * enforces the same rule in the resolver for callers that pass the name as a
 * bare string (chat `manifest`, OpenAI `model`).
 */
export const MANIFEST_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Throw when a manifest name is empty, too long, or contains characters that
 * are unsafe as an R2 key segment. Used by `resolveManifest` so every
 * request-path caller is contained regardless of its own input schema.
 */
export function assertValidManifestName(name: string): void {
  if (!name || name.length > 128 || !MANIFEST_NAME_RE.test(name)) {
    throw new Error(`Invalid manifest name: ${JSON.stringify(name)}`);
  }
}

export const Pattern = z
  .string()
  .min(1)
  .openapi('Pattern', {
    description:
      'Execution pattern name resolved through the pattern registry. Built-ins: `react`, ' +
      '`deep`, `reflect`, `plan_execute` (single-agent); `router`, `parallel`, `groupchat` ' +
      '(multi-agent). `deep` extends `react` with planning tools; `reflect` wraps a react ' +
      'base with a verifier model; `plan_execute` splits the loop into planner / executor / ' +
      'synthesizer passes. Multi-agent patterns require `sub_agents` and forbid `peers`. ' +
      'New patterns can be registered via `registerPattern(name, builder)`; unknown names ' +
      'raise a build-time error listing the registered set.',
    example: 'react',
  });
export type Pattern = z.infer<typeof Pattern>;

const Metadata = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(MANIFEST_NAME_RE)
      .openapi({
        description:
          'Used as the manifest id, the OpenAI `model` value, the audit `manifest_id`, and an ' +
          'R2 override object-key segment. 1–128 characters, restricted to ' +
          '`[a-zA-Z0-9._-]` (no slashes or whitespace) so it cannot escape its key prefix.',
        example: 'quick',
      }),
    version: z.string().default('1.0.0').openapi({
      description: 'Free-form version string. Surfaced in the A2A agent card.',
      example: '1.0.0',
    }),
    description: z.string().default('').openapi({
      description: 'Free-form description. Surfaced in the A2A agent card.',
    }),
    tags: z.array(z.string()).default([]).openapi({
      description: 'Free-form tag list.',
    }),
  })
  .strict()
  .openapi('Metadata');

const Model = z
  .object({
    id: z
      .string()
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          'Logical model id resolved through `MODEL_ROUTES` (a JSON map in env vars) to ' +
          '`{ provider, model }`. Null falls back to `env.DEFAULT_MODEL_ID`.',
        example: 'claude-sonnet-4',
      }),
    temperature: z.number().default(0).openapi({
      description: 'Sampling temperature. Forced to `1` when `thinking_budget` is set.',
      example: 0,
    }),
    max_tokens: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .default(null)
      .openapi({ description: 'Per-call output cap. Null uses the provider default.' }),
    region: z
      .string()
      .nullable()
      .optional()
      .default(null)
      .openapi({ description: 'Advisory; not currently routed on.' }),
    cache: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'When true, Anthropic-routed calls send `cache_control: ephemeral` markers on ' +
          'the system prompt, the last tool definition, and the last conversation message. ' +
          'Subsequent turns read those prefixes from Anthropic’s prompt cache (~10% input ' +
          'cost, lower TTFT). No-op for OpenAI / Workers AI — OpenAI prompt caching is ' +
          'automatic and surfaces through `cached_tokens` regardless of this flag.',
      }),
    thinking_budget: z
      .number()
      .int()
      .min(1024)
      .max(64000)
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          'Extended-thinking budget (Anthropic only). When set, the request includes ' +
          '`thinking: { type: enabled, budget_tokens: N }`, temperature is forced to 1, ' +
          'and `max_tokens` is bumped to at least `budget + 1024`. Returned `thinking` ' +
          'blocks are captured on the assistant message and round-tripped on the next ' +
          'request — Anthropic rejects tool-result follow-ups that drop preceding thinking ' +
          'blocks. Range 1024–64000. No-op for OpenAI / Workers AI.',
      }),
    fallbacks: z
      .array(z.string())
      .default([])
      .openapi({
        description:
          'Ordered list of logical model ids to try when the primary `id` returns a ' +
          '`provider_error` (HTTP 5xx, gateway exhaustion, or any non-retryable upstream ' +
          'failure). Each fallback resolves through the same `MODEL_ROUTES` map as the ' +
          'primary; a successful fallback emits a `model_switch` audit event with `from` ' +
          'and `to` ids so the operator can see when degraded routing kicked in. Empty ' +
          'array disables fallbacks (the existing behavior).',
        example: ['claude-haiku-4', 'llama-3-pro'],
      }),
    confidence_escalation: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .openapi({
            description:
              'When true, low-confidence responses trigger a re-call against `escalate_to`. ' +
              'Heuristic markers + short-response check; lightweight and provider-agnostic.',
          }),
        escalate_to: z
          .string()
          .default('')
          .openapi({
            description:
              'Logical model id used on escalation. Typically your flagship (sonnet, opus, gpt-5-pro). ' +
              'Empty disables escalation even when `enabled: true`.',
          }),
        low_confidence_markers: z
          .array(z.string())
          .default([
            'i am not sure',
            "i don't know",
            'i cannot answer',
            'unclear',
            'uncertain',
            'no information',
          ])
          .openapi({
            description:
              'Lower-cased substrings that mark a response as low confidence. When the response ' +
              'matches any of these OR is shorter than `min_response_chars`, the escalation fires.',
          }),
        min_response_chars: z
          .number()
          .int()
          .min(0)
          .default(40)
          .openapi({
            description:
              'Responses shorter than this are treated as low-confidence. Tune up for tasks ' +
              'where a short response is fine (yes/no questions); down for long-form work.',
          }),
      })
      .strict()
      .default({
        enabled: false,
        escalate_to: '',
        low_confidence_markers: [
          'i am not sure',
          "i don't know",
          'i cannot answer',
          'unclear',
          'uncertain',
          'no information',
        ],
        min_response_chars: 40,
      })
      .openapi('ConfidenceEscalation', {
        description:
          'When the primary model returns a response that looks low-confidence (matches a ' +
          'marker OR is shorter than `min_response_chars`), the wrapper re-calls the model at ' +
          '`escalate_to` and uses that response instead. Emits a `model_switch` audit event ' +
          'with `reason: "low_confidence"`.',
      }),
  })
  .strict()
  .openapi('Model');

const SystemPrompt = z
  .object({
    inline: z.string().default('').openapi({
      description: 'Inline system prompt text.',
    }),
    soul: z.boolean().default(false).openapi({
      description: 'When true, loads from `deps.soulLoader(tenantId)` at build time.',
    }),
    base: z.string().default('').openapi({
      description: 'Base prompt fragment.',
    }),
  })
  .strict()
  .openapi('SystemPrompt', {
    description:
      'System prompt assembly. Parts are joined with `\\n\\n---\\n\\n` in the order ' +
      '**soul → base → inline**. Empty parts are dropped. If every part is empty the ' +
      'builder falls back to `"You are <name>. Use your tools when needed to answer ' +
      'accurately."`.',
  });

const SkillRef = z
  .object({
    name: z.string().openapi({
      description: 'Skill name (bundled `SKILL.md` directory).',
      example: 'web-search',
    }),
    version: z.string().nullable().optional().default(null).openapi({
      description: 'Optional pinned version. Null uses the active version.',
    }),
  })
  .strict()
  .openapi('SkillRef');

const SafeOutboundUrl = z.url().refine(
  (u) => {
    try {
      // Parse-time check; the runtime check (which knows the env's
      // allow-list) lives in security/ssrf.ts and is also called before
      // each outbound fetch.
      assertSafeOutboundUrl(u);
      return true;
    } catch {
      return false;
    }
  },
  {
    message: 'url is not allowed (must be https, non-private; see SSRF_ALLOW_HOSTS for exceptions)',
  },
);

const McpServerRef = z
  .object({
    name: z.string().openapi({
      description:
        'Local name for the server. Tools from this server are namespaced as ' +
        '`<name>__<toolName>`.',
      example: 'notion',
    }),
    url: SafeOutboundUrl.openapi({
      description:
        'Server URL. SSRF-guarded at parse time: `http://` is rejected outside dev, and ' +
        'private-range IPs / `.internal` / `.cluster.local` hosts are blocked unless added ' +
        'to `SSRF_ALLOW_HOSTS`.',
      example: 'https://mcp.notion.example.com',
    }),
    auth: z.string().default('').openapi({
      description: '`cf-access`, a bearer token marker, or empty for no auth.',
    }),
    transport: z.enum(['http', 'sse', 'stdio']).default('sse').openapi({
      description: 'Transport protocol.',
    }),
  })
  .strict()
  .openapi('McpServerRef');

const A2APeerRef = z
  .object({
    name: z.string().openapi({
      description:
        'Local name for the peer. Each peer becomes a `peer_<name>` tool that delegates ' +
        'via A2A `tasks/send`. The `peer_` prefix is significant — the limits wrapper ' +
        'increments `peerHops` on every call.',
      example: 'billing',
    }),
    url: SafeOutboundUrl.openapi({
      description: 'Peer base URL. SSRF-guarded like `mcp_servers[].url`.',
      example: 'https://billing.felix.run',
    }),
    auth: z.string().default('').openapi({
      description: 'Optional auth marker forwarded on peer requests.',
    }),
  })
  .strict()
  .openapi('A2APeerRef');

const ContainerRef = z
  .object({
    name: z
      .string()
      .min(1)
      .openapi({
        description:
          'Local tool name surfaced to the model. The model calls this name; the harness ' +
          'routes the call through a `ContainerExecutor` to the configured gateway. Tool ' +
          'audit rows carry `transport: container`.',
        example: 'python_runner',
      }),
    description: z.string().default('').openapi({
      description: 'Human/LLM-readable description of what the container does.',
    }),
    gateway_url: SafeOutboundUrl.openapi({
      description:
        'HTTPS URL of the container / sandbox gateway. SSRF-guarded — must be `https://`, ' +
        'non-private, or explicitly listed in `SSRF_ALLOW_HOSTS`. The gateway accepts ' +
        '`POST { image, tool, arguments }` and returns `{ content, exit_code?, stderr? }`.',
      example: 'https://sandbox.felix.run/run',
    }),
    image: z
      .string()
      .min(1)
      .openapi({
        description:
          'Image / sandbox identifier the gateway should run. Free-form; the gateway is ' +
          'trusted to validate that the caller may run it.',
        example: 'ghcr.io/felix/python-3.12:latest',
      }),
    container_tool_name: z
      .string()
      .default('')
      .openapi({
        description:
          'Tool name as seen inside the container. Defaults to `name` when empty — only ' +
          'set this when one image exposes multiple tools and the inward name differs.',
      }),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          'Per-call wall-clock cap, composed with `ctx.signal`. Either source aborts the ' +
          'in-flight gateway fetch. Null disables the per-call timeout (the request-scope ' +
          '`limits.max_wall_clock_seconds` still applies).',
        example: 30000,
      }),
    auth: z
      .string()
      .default('')
      .openapi({
        description:
          'Optional auth marker passed to the credential broker. The broker returns an ' +
          '`Authorization` header for the gateway request; the value never reaches the ' +
          'container itself. Empty means no auth header is sent.',
      }),
    args_schema: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          'Optional JSON Schema describing the tool inputs. When set, it is advertised ' +
          'to the model verbatim (via `rawInputSchema`) — useful when the container owns ' +
          'a richer schema than the permissive default. When unset, an empty object schema ' +
          'is advertised and the gateway is responsible for input validation.',
      }),
    fatal: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'When true, transport errors terminate the react loop instead of being fed back ' +
          'to the model as `[container error] …`. Default false — let the model recover.',
      }),
  })
  .strict()
  .openapi('ContainerRef');

const BrowserToolRef = z
  .object({
    name: z
      .string()
      .min(1)
      .openapi({
        description:
          'Local tool name surfaced to the model. The model calls this name; the harness ' +
          'routes the call through a `BrowserExecutor` (`transport: browser`) targeting the ' +
          'bound Fetcher. Audit rows carry `transport: browser`.',
        example: 'fetch_page',
      }),
    description: z.string().default('').openapi({
      description: 'Human/LLM-readable description of what the browser tool does.',
    }),
    binding: z
      .string()
      .min(1)
      .openapi({
        description:
          'Worker binding name for the Browser Rendering Fetcher (Service binding wrapping ' +
          '`@cloudflare/puppeteer`, or a DO-stub adapter). Build-time lookup against ' +
          '`env[binding]`; missing binding fails the build.',
        example: 'BROWSER',
      }),
    op: z
      .enum(['content', 'links', 'snapshot', 'screenshot', 'pdf', 'json'])
      .default('content')
      .openapi({
        description:
          'Browser-side operation the wrapper Worker routes on. `content` returns HTML; ' +
          '`links` returns extracted hyperlinks; `snapshot` returns `{ html, screenshot_base64 }`; ' +
          '`screenshot` / `pdf` return base64-encoded bytes; `json` returns the JSON body of a ' +
          'URL that already returns JSON (skip Chromium entirely).',
      }),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          'Per-call wall-clock cap, composed with `ctx.signal`. Either source aborts the ' +
          'in-flight browser fetch.',
        example: 30000,
      }),
    path_prefix: z
      .string()
      .default('')
      .openapi({
        description:
          'Optional sub-path prepended before `/{op}` so the wrapper Worker can mount under ' +
          'e.g. `/browser`. Defaults to empty.',
      }),
    args_schema: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          'Optional JSON Schema for the tool inputs; advertised verbatim through `rawInputSchema` ' +
          'when set. Without it, an empty object schema is advertised and the wrapper Worker ' +
          'owns input validation.',
      }),
    fatal: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'When true, transport errors terminate the react loop instead of being fed back to ' +
          'the model as `[browser error] …`. Default false.',
      }),
  })
  .strict()
  .openapi('BrowserToolRef');

const SandboxRef = z
  .object({
    name: z
      .string()
      .min(1)
      .openapi({
        description:
          'Local tool name surfaced to the model. The model calls this name; the harness ' +
          'routes the call through a `SandboxExecutor` (`transport: sandbox`) to the bound ' +
          'Fetcher. Audit rows carry `transport: sandbox`.',
        example: 'python_runner',
      }),
    description: z.string().default('').openapi({
      description: 'Human/LLM-readable description of what the sandbox tool does.',
    }),
    binding: z
      .string()
      .min(1)
      .openapi({
        description:
          'Worker binding name (Service binding or a DO-stub Fetcher adapter) that exposes ' +
          'the sandbox. The builder resolves it against `env[binding]` at build time; a ' +
          'missing binding fails the build so a misconfigured manifest never silently no-ops. ' +
          'For `@cloudflare/sandbox`, wire a Service binding pointing at a worker that wraps ' +
          'the SDK.',
        example: 'SANDBOX',
      }),
    sandbox_tool_name: z
      .string()
      .default('')
      .openapi({
        description:
          'Tool name as seen by the sandbox. Defaults to `name` when empty — set this only ' +
          'when one binding exposes multiple tools and the inward name differs.',
      }),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          'Per-call wall-clock cap, composed with `ctx.signal`. Either source aborts the ' +
          'in-flight sandbox fetch. Null defers to the request-scope `limits.max_wall_clock_seconds`.',
        example: 30000,
      }),
    path_prefix: z
      .string()
      .default('')
      .openapi({
        description:
          'Optional sub-path the executor prepends before `/exec`. Useful when the underlying ' +
          'sandbox Worker mounts under a sub-path (e.g. `/sbx`). Defaults to empty.',
      }),
    args_schema: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          'Optional JSON Schema for the tool inputs. When set, it is advertised to the model ' +
          'verbatim through `rawInputSchema`; when unset, an empty object schema is advertised ' +
          'and the sandbox owns input validation.',
      }),
    fatal: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'When true, transport errors terminate the react loop instead of being fed back to ' +
          'the model as `[sandbox error] …`. Default false — let the model recover.',
      }),
  })
  .strict()
  .openapi('SandboxRef');

const QueueRef = z
  .object({
    name: z
      .string()
      .min(1)
      .openapi({
        description:
          'Local tool name surfaced to the model. The model calls this name; the harness ' +
          'routes the call through a `QueueExecutor` that enqueues a job and returns a ' +
          'stub. The eventual `tool_result` lands when a consumer writes it back to the ' +
          'session — `session.wake()` + `tasks/resubscribe` complete the resume. Tool ' +
          'audit rows carry `transport: queue`.',
        example: 'long_research',
      }),
    description: z.string().default('').openapi({
      description: 'Human/LLM-readable description of what the queued tool does.',
    }),
    queue_binding: z
      .string()
      .min(1)
      .openapi({
        description:
          'Worker binding name for the Cloudflare Queues producer. The builder resolves ' +
          'it against `env[binding]` at build time; a missing binding fails the build so ' +
          'a misconfigured manifest never silently no-ops.',
        example: 'JOBS_QUEUE',
      }),
    deadline_ms: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          'Optional deadline (relative ms) advertised on the queue message. Consumers ' +
          'should honor it; if the work would land past `deadline_ms`, the consumer ' +
          'should emit a `queue_expired` audit and skip writing a `tool_result` so the ' +
          'orphan cleanup path runs instead. Null leaves the deadline open-ended.',
        example: 60000,
      }),
    args_schema: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          'Optional JSON Schema describing the tool inputs. When set, it is advertised ' +
          'to the model verbatim (via `rawInputSchema`). When unset, an empty object ' +
          'schema is advertised; the consumer is responsible for input validation on the ' +
          'receiving end.',
      }),
    fatal: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'When true, enqueue failures terminate the react loop. Default false — let the ' +
          'model see the `[queue error]` string and decide how to recover.',
      }),
  })
  .strict()
  .openapi('QueueRef');

const SessionSpec = z
  .object({
    strategy: z
      .string()
      .default('full_replay')
      .openapi({
        description:
          'Controls how prior session events are rendered into the working-set message ' +
          'array before each model call. `full_replay` (default) replays every prior ' +
          'message. `windowed:<N>` keeps the last N events. `summarizing:<N>` keeps the ' +
          'last N raw events and model-summarizes everything older into a synthetic system ' +
          'message (cached as an audit event). `semantic:<N>` embeds the current message ' +
          'via BGE and pulls the top-N most relevant prior events instead of the most ' +
          'recent. Anchor messages (`metadata.pinned`) are always included. Unknown values ' +
          'fall back to `full_replay`. Implemented as a swappable `SessionStrategy`.',
        example: 'full_replay',
      }),
  })
  .strict()
  .openapi('SessionSpec');

const Memory = z
  .object({
    checkpointer: z
      .enum(['agentcore', 'sqlite', 'do', 'none'])
      .default('do')
      .openapi({
        description:
          'Conversation persistence. `do` (default) uses `ConversationDO`. `agentcore` / ' +
          '`sqlite` are legacy aliases for `do`. `none` disables checkpointing.',
      }),
    store: z
      .enum(['agentcore', 'memory', 'vectorize', 'none'])
      .default('vectorize')
      .openapi({
        description:
          'Long-term semantic memory. `vectorize` (default; legacy name) uses the pgvector-backed store — when ' +
          'set, the builder auto-injects `memory_remember` / `memory_recall` tools. ' +
          '`agentcore` / `memory` are legacy aliases. `none` disables the store.',
      }),
  })
  .strict()
  .openapi('Memory');

const InboundAuth = z
  .object({
    schemes: z.array(z.string()).default([]).openapi({
      description: 'Informational; surfaced in the agent card. Not enforced at the edge.',
    }),
    required_scopes: z
      .array(z.string())
      .default([])
      .openapi({
        description:
          'AND-checked against `principal.scopes`. Missing scopes return 403 from ' +
          '`enforceManifestAuth`.',
      }),
    allow_anonymous: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'When false (default), anonymous callers receive 401. When true, requests without ' +
          'a bearer token are accepted as the tenant resolved by `JWT_VERIFIERS` (typically ' +
          'the `default` tenant).',
      }),
  })
  .strict()
  .openapi('InboundAuth');

const OutboundAuth = z
  .object({
    providers: z.array(z.string()).default([]).openapi({
      description: 'OAuth provider names this agent will call. Used by the outbound auth registry.',
    }),
  })
  .strict()
  .openapi('OutboundAuth');

const AuthRequirement = z
  .object({
    inbound: InboundAuth.default(InboundAuth.parse({})),
    outbound: OutboundAuth.default(OutboundAuth.parse({})),
  })
  .strict()
  .openapi('AuthRequirement', {
    description:
      'Inbound gating (`enforceManifestAuth`) and outbound provider list. `inbound` ' +
      'decides who can call this agent; `outbound` lists OAuth providers the agent uses.',
  });

const A2ACapability = z
  .object({
    id: z.string().openapi({ description: 'Capability id surfaced verbatim in the agent card.' }),
    description: z
      .string()
      .default('')
      .openapi({ description: 'Free-form capability description.' }),
    input_schema_ref: z.string().default('').openapi({
      description: 'Optional reference to a JSON Schema for the capability’s input.',
    }),
  })
  .strict()
  .openapi('A2ACapability');

const A2APublishSpec = z
  .object({
    publish: z.boolean().default(false).openapi({
      description: 'When true, this manifest is offered for A2A peering.',
    }),
    capabilities: z.array(A2ACapability).default([]).openapi({
      description: 'Capability entries surfaced verbatim in the agent card.',
    }),
  })
  .strict()
  .openapi('A2APublishSpec');

const Observability = z
  .object({
    trace: z.boolean().default(true).openapi({
      description: 'When true, opens a `manifestSpan` per build.',
    }),
    metrics: z.array(z.string()).default([]).openapi({
      description: 'Free-form list of metric names this manifest emits. Emission is opt-in.',
    }),
  })
  .strict()
  .openapi('Observability');

const ProceduralSpec = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'When true, the react loop stores successful (intent → tool sequence) pairs in ' +
          'the vector store after each run and auto-injects the `recall_procedure` tool the model ' +
          'can use to look up past successes.',
      }),
    top_k: z
      .number()
      .int()
      .positive()
      .default(3)
      .openapi({ description: 'Number of past procedures returned by `recall_procedure`.' }),
    embedding_model: z.string().default('@cf/baai/bge-base-en-v1.5').openapi({
      description: 'Workers-AI embedding model used to index + query procedural memory.',
    }),
  })
  .strict()
  .openapi('ProceduralSpec');

const ReflectSpec = z
  .object({
    verifier_model: z
      .string()
      .default('')
      .openapi({
        description:
          'Logical model id the verifier uses. Empty → falls back to the primary model id. ' +
          'Typically you want this cheaper — `claude-haiku-4` against a Sonnet primary.',
      }),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.7)
      .openapi({ description: 'Verifier score floor for a pass. Below this triggers a replay.' }),
    max_iterations: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(2)
      .openapi({
        description:
          'Maximum react passes (1 = no reflection). 2 is the sweet spot for most tasks; 3 ' +
          'helps complex generative work.',
      }),
    criteria: z
      .string()
      .default('')
      .openapi({
        description:
          'Free-form criteria the verifier scores against. The primary goal of the user ' +
          "first turn is implicit. Empty → verifier uses 'general helpfulness'.",
      }),
  })
  .strict()
  .openapi('ReflectSpec');

const AnomalySpec = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .openapi({
        description:
          'When false, the anomaly-detection cron never flags this manifest (and never ' +
          'auto-rolls-back its canary). Use to mute an intentionally-flaky manifest.',
      }),
    min_volume: z
      .number()
      .int()
      .min(1)
      .default(10)
      .openapi({
        description:
          'Minimum tool-call volume in the recent window before a spike can be flagged. ' +
          'Raise for low-traffic manifests that would otherwise trip on a handful of errors.',
      }),
    min_rate: z
      .number()
      .min(0)
      .max(1)
      .default(0.2)
      .openapi({
        description:
          'Minimum recent error rate (0–1) required to flag. Raise for manifests whose ' +
          'tools fail often by design.',
      }),
    baseline_factor: z
      .number()
      .min(1)
      .default(3)
      .openapi({
        description:
          'Recent error rate must exceed `baseline_factor ×` the 24h baseline rate to flag. ' +
          'Raise to require a sharper spike before alerting.',
      }),
  })
  .strict()
  .openapi('AnomalySpec');

export type AnomalyConfig = z.infer<typeof AnomalySpec>;
export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = AnomalySpec.parse({});

const ArtifactsSpec = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'When true, tool results exceeding `threshold_chars` are spilled to R2 and the ' +
          'model sees a `[artifact:REF]` stub it can read via the auto-injected ' +
          '`fetch_artifact` tool. Off by default to preserve existing behavior.',
      }),
    threshold_chars: z
      .number()
      .int()
      .positive()
      .default(8000)
      .openapi({ description: 'Spill tool results whose stringified output exceeds this length.' }),
    preview_chars: z.number().int().positive().default(200).openapi({
      description: 'First N chars of the spilled content retained inline in the stub.',
    }),
    default_window_chars: z.number().int().positive().default(4000).openapi({
      description: 'Default chars returned by `fetch_artifact` when `length` is omitted.',
    }),
    max_window_chars: z
      .number()
      .int()
      .positive()
      .default(16000)
      .openapi({ description: 'Hard cap on a single `fetch_artifact` window.' }),
  })
  .strict()
  .openapi('ArtifactsSpec');

const ToolsRetrievalSpec = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .openapi({
        description:
          'When true, the react/deep loop filters the tool list each turn to the top-K most ' +
          'relevant tools by cosine similarity over BGE embeddings. Off by default.',
      }),
    top_k: z
      .number()
      .int()
      .positive()
      .default(20)
      .openapi({
        description:
          'Number of tools advertised to the model per turn. Below this count, retrieval is a ' +
          'no-op. Tune up for ambiguous user intents; tune down to crunch token budgets.',
      }),
    model: z
      .string()
      .default('@cf/baai/bge-base-en-v1.5')
      .openapi({
        description:
          'Workers-AI embedding model used to rank tool descriptions. `bge-base-en-v1.5` ' +
          'balances quality and cost; swap to `bge-m3` for multilingual.',
      }),
  })
  .strict()
  .openapi('ToolsRetrievalSpec');

const PlanExecuteSpec = z
  .object({
    planner_model: z
      .string()
      .default('')
      .openapi({
        description:
          'Logical model id the planner uses. Empty → falls back to the primary model id. ' +
          'Usually you want this larger (a flagship Sonnet/Opus) since planning quality ' +
          'compounds across subtasks.',
      }),
    executor_model: z
      .string()
      .default('')
      .openapi({
        description:
          'Logical model id the executor uses. Empty → falls back to the primary model id. ' +
          'Often cheaper than the planner (Haiku / Llama 3 70B fast); the executor is the ' +
          'hot loop, so the cost per subtask matters.',
      }),
    max_subtasks: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(8)
      .openapi({
        description:
          'Hard cap on subtasks in a single plan. Plans longer than this are truncated; ' +
          'the planner is expected to summarize. 8 covers most real plans; raise for ' +
          'multi-day style tasks. Hard ceiling 20 — past that you want sub-agents.',
      }),
    replan_on_failure: z
      .boolean()
      .default(true)
      .openapi({
        description:
          'When a subtask returns a tool-error terminal or its assistant turn does not ' +
          'declare success, call the planner again with the executor critique + remaining ' +
          'subtasks to revise the plan. Disable for deterministic plans where any failure ' +
          'should abort the run.',
      }),
    max_replans: z
      .number()
      .int()
      .min(0)
      .max(5)
      .default(2)
      .openapi({
        description:
          'Number of times the planner may revise the plan in a single invocation. 0 = ' +
          'never replan (any failure aborts). Plans should usually converge in 1–2 replans; ' +
          'higher numbers indicate the planner needs better few-shot examples.',
      }),
    executor_recursion_limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(6)
      .openapi({
        description:
          'Per-subtask react recursion cap. Each subtask is its own react sub-loop with ' +
          'this many model turns — sharing the manifest-level `recursion_limit` would let ' +
          'one rogue subtask exhaust the whole budget.',
      }),
    planner_few_shots: z
      .number()
      .int()
      .min(0)
      .max(10)
      .default(3)
      .openapi({
        description:
          'When `spec.procedural_memory.enabled`, prepend up to N past successful plans for ' +
          'this manifest into the planner prompt. 0 disables the few-shot pull even when ' +
          'procedural memory is on. Plans surface through `recall_procedure` filtered to ' +
          'the manifest id.',
      }),
  })
  .strict()
  .openapi('PlanExecuteSpec');

const ExecutionSpec = z
  .object({
    mode: z
      .enum(['transient', 'durable'])
      .default('transient')
      .openapi({
        description:
          'Execution durability. `transient` (default) runs the agent loop in-isolate — ' +
          'a worker eviction mid-loop loses the in-flight branch. `durable` routes through ' +
          'the `AGENT_WORKFLOW` Cloudflare Workflows binding: each invocation becomes a ' +
          'Workflow instance that survives evictions, retries on transient errors, and ' +
          'pairs with A2A `tasks/resubscribe` for client-side resume. Only valid on ' +
          'single-agent patterns (`react`, `deep`) — multi-agent patterns supervise ' +
          'children whose own durability is opted into by their leaf manifests.',
        example: 'transient',
      }),
    resume_token_ttl_seconds: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          'Advisory TTL for the Workflow instance id — clients may use this to know how ' +
          'long a resume token stays valid for `tasks/resubscribe`. Null defers to the ' +
          'Workflows runtime default. No-op when `mode` is `transient`.',
      }),
  })
  .strict()
  .openapi('ExecutionSpec');

export const AgentSpec = z
  .object({
    pattern: Pattern.default('react').openapi({
      description: 'Execution pattern. See `Pattern` for the full list.',
    }),
    model: Model.default(Model.parse({})).openapi({
      description: 'Model configuration (id, temperature, caching, extended thinking).',
    }),
    system_prompt: SystemPrompt.default(SystemPrompt.parse({})).openapi({
      description: 'System prompt parts (soul / base / inline).',
    }),
    tools: z
      .array(z.string())
      .default([])
      .openapi({
        description:
          'Tool names registered with the `ToolProvider`. Built-ins include `calculator`, ' +
          '`list_skills`, `activate_skill`, `deactivate_skill`. Skills can fold in additional ' +
          'tool names at build time.',
        example: ['calculator'],
      }),
    skills: z
      .array(SkillRef)
      .default([])
      .openapi({
        description:
          'References to bundled `SKILL.md` files. Each skill contributes tools, MCP server ' +
          'names, and A2A peer names; its Markdown body is appended to the system prompt ' +
          'under an `## Active Skills` header. Activation is per-tenant and restriction-only.',
      }),
    mcp_servers: z.array(McpServerRef).default([]).openapi({
      description: 'External MCP servers whose tools are namespaced and exposed to this agent.',
    }),
    peers: z
      .array(A2APeerRef)
      .default([])
      .openapi({
        description:
          'A2A peer endpoints. Each becomes a `peer_<name>` tool. Forbidden when `pattern` ' +
          'is `router` / `parallel` / `groupchat`.',
      }),
    containers: z
      .array(ContainerRef)
      .default([])
      .openapi({
        description:
          'Container-backed tools. Each entry becomes a `Tool` whose executor is a ' +
          '`ContainerExecutor` (`transport: container`) pointing at the declared gateway. ' +
          'Used for sandboxed code execution and other untrusted side-effects — the brain ' +
          '(model loop) sees `execute(name, input) → string`; the harness routes the call ' +
          'through the gateway so the work runs in isolation.',
      }),
    queues: z
      .array(QueueRef)
      .default([])
      .openapi({
        description:
          'Queue-backed (async) tools. Each entry becomes a `Tool` whose executor is a ' +
          '`QueueExecutor` (`transport: queue`) bound to a Cloudflare Queue. Used for ' +
          'long-running work that resolves across requests: dispatch enqueues a job + ' +
          'returns a stub, a separate consumer writes a `tool_result` event back to the ' +
          'session keyed to the dispatching `tool_call_id`, and the next client ' +
          '`tasks/resubscribe` picks up the resolved cycle.',
      }),
    sandboxes: z
      .array(SandboxRef)
      .default([])
      .openapi({
        description:
          'Sandbox-backed tools. Each entry becomes a `Tool` whose executor is a ' +
          '`SandboxExecutor` (`transport: sandbox`) targeting a worker-local Fetcher (Service ' +
          'binding or DO-stub adapter). Used for sandboxed code execution with a true ' +
          'filesystem-bearing surface — pairs with the `@cloudflare/sandbox` SDK without ' +
          'requiring an external gateway / SSRF guard / auth broker.',
      }),
    browser_tools: z
      .array(BrowserToolRef)
      .default([])
      .openapi({
        description:
          'Browser-Rendering-backed tools. Each entry becomes a `Tool` whose executor is a ' +
          '`BrowserExecutor` (`transport: browser`) targeting a worker-local Fetcher that ' +
          'wraps `@cloudflare/puppeteer` (or the Browser Rendering REST API). Built-in ops: ' +
          '`content` / `links` / `snapshot` / `screenshot` / `pdf` / `json`.',
      }),
    sub_agents: z
      .array(z.string())
      .default([])
      .openapi({
        description:
          'Sub-agent manifest names. **Required** when `pattern ∈ {router, parallel, ' +
          'groupchat}`; **forbidden** otherwise. Resolved through the same `loadManifest` ' +
          'path — cycles will recurse.',
      }),
    aggregator_prompt: z
      .string()
      .default('')
      .openapi({
        description:
          'Only allowed when `pattern: parallel`. Overrides the system prompt for the ' +
          'synthesis step. If empty, the system prompt is used as the aggregator prompt.',
      }),
    max_turns: z
      .number()
      .int()
      .positive()
      .max(ABSOLUTE_LIMITS.max_turns)
      .default(4)
      .openapi({
        description:
          'Number of `groupchat` turns (and an indirect cap on `parallel` children). ' +
          `Clamped to ${ABSOLUTE_LIMITS.max_turns}.`,
        example: 4,
      }),
    memory: Memory.default(Memory.parse({})).openapi({
      description: 'Conversation checkpointer and long-term store selection.',
    }),
    session: SessionSpec.default(SessionSpec.parse({})).openapi({
      description:
        'Session render strategy — chooses how prior events are turned into the ' +
        'working-set message array. Distinct from `memory.checkpointer`, which gates ' +
        'whether events are persisted at all.',
    }),
    auth: AuthRequirement.default(AuthRequirement.parse({})).openapi({
      description: 'Inbound auth gate (who can call this agent) and outbound provider list.',
    }),
    a2a: A2APublishSpec.default(A2APublishSpec.parse({})).openapi({
      description:
        'A2A publishing settings — whether the agent is offered for peering and its capability list.',
    }),
    observability: Observability.default(Observability.parse({})).openapi({
      description: 'Tracing and metric emission opt-ins.',
    }),
    execution: ExecutionSpec.default(ExecutionSpec.parse({})).openapi({
      description:
        'Durability mode for the agent loop. `transient` runs in-isolate; `durable` ' +
        'wraps every invocation in a Cloudflare Workflow so a worker eviction mid-run ' +
        'replays cleanly.',
    }),
    tools_retrieval: ToolsRetrievalSpec.default(ToolsRetrievalSpec.parse({})).openapi({
      description:
        'Just-in-time tool retrieval. When enabled, only the top-K tools by embedding ' +
        'similarity to the recent conversation are advertised to the model — crucial at ' +
        '30+ tool catalogs. Falls back to the full tool list when `env.AI` is absent.',
    }),
    artifacts: ArtifactsSpec.default(ArtifactsSpec.parse({})).openapi({
      description:
        'Reference-based artifacts. When enabled, oversized tool results are spilled to R2 ' +
        'and the model reads them on demand via `fetch_artifact`. Cuts context spent on ' +
        'sandbox stdout dumps, scraped HTML, and large JSON arrays.',
    }),
    reflect: ReflectSpec.default(ReflectSpec.parse({})).openapi({
      description:
        'Reflection / verifier loop options consumed by `pattern: reflect`. No-op for other ' +
        'patterns. Wraps the underlying react loop with a verifier model that scores each ' +
        'final response and replays with critique on a below-threshold score. Streaming ' +
        'forwards each iteration live; when the verifier rolls a run back, the revised draft ' +
        'streams after the first, so token-concatenating clients (the OpenAI-compatible ' +
        'streaming surface) see successive drafts appended — the authoritative answer is the ' +
        'final terminal event.',
    }),
    plan_execute: PlanExecuteSpec.default(PlanExecuteSpec.parse({})).openapi({
      description:
        'Planner/executor split options consumed by `pattern: plan_execute`. No-op for other ' +
        'patterns. The planner emits a JSON plan; the executor runs one subtask at a time ' +
        'with the manifest tools and reports back; the planner may revise the plan up to ' +
        '`max_replans` times before synthesizing the final assistant turn.',
    }),
    procedural_memory: ProceduralSpec.default(ProceduralSpec.parse({})).openapi({
      description:
        'Procedural memory. When enabled, successful runs are distilled into ' +
        '(intent → tool_call_sequence) vectors stored in the pgvector memory table, and `recall_procedure` ' +
        'is auto-injected so the model can look up past successes as few-shot examples.',
    }),
    policies: z
      .array(PolicySchema)
      .default([])
      .openapi({
        description:
          'Declarative scope policies. Tools listed in multiple policies must satisfy all ' +
          'of them (AND logic). Federation bundle policies merge with these and win on id collision.',
      }),
    limits: LimitsSchema.default(LimitsSchema.parse({})).openapi({
      description: 'Per-run caps (tool calls, wall clock, peer hops, tokens).',
    }),
    guardrails: GuardrailsSchema.default(GuardrailsSchema.parse({})).openapi({
      description: 'Input/output content guardrails (PII regex, AI Gateway hook).',
    }),
    anomaly: AnomalySpec.default(AnomalySpec.parse({})).openapi({
      description:
        'Per-manifest tuning for the anomaly-detection cron. Overrides the global ' +
        'enable / min_volume / min_rate / baseline_factor thresholds so a noisy manifest ' +
        'can dampen (or mute) the detector for itself. Detection windows stay global.',
    }),
    approvals: z
      .array(ApprovalRuleSchema)
      .default([])
      .openapi({
        description:
          'Human-in-the-loop approval rules. When a tool listed under a rule is called, the ' +
          'wrapper persists an `approval_request` row and returns a deny string to the model; ' +
          'the next retry with the same arguments after a `POST /approvals/{id}/decide` goes through.',
      }),
    recursion_limit: z
      .number()
      .int()
      .positive()
      .max(ABSOLUTE_LIMITS.recursion_limit)
      .nullable()
      .optional()
      .default(null)
      .openapi({
        description:
          'Bounds **model turns** for `react` and `deep`. One model response that emits ' +
          'five tool calls counts as one step — use `limits.max_tool_calls` for per-call ' +
          `caps. Null uses the pattern default of 10. Ceiling: ${ABSOLUTE_LIMITS.recursion_limit}.`,
      }),
  })
  .strict()
  .openapi('AgentSpec');
export type AgentSpec = z.infer<typeof AgentSpec>;

export const ManifestSchema = z
  .object({
    apiVersion: z
      .string()
      .default(API_VERSION)
      .openapi({ description: 'Must equal `orchestrator/v1`.', example: API_VERSION }),
    kind: z
      .string()
      .default(MANIFEST_KIND)
      .openapi({ description: 'Must equal `Agent`.', example: MANIFEST_KIND }),
    metadata: Metadata,
    spec: AgentSpec.default(AgentSpec.parse({})),
  })
  .strict()
  .openapi('Manifest', {
    description:
      'A compiled-at-build-or-load-time spec describing one agent: its execution pattern, ' +
      'model, tools, skills, governance, and auth. Resolved through the four-layer chain ' +
      '(tenant D1 → tenant R2 → global R2 → bundled) on every request.',
    example: {
      apiVersion: API_VERSION,
      kind: MANIFEST_KIND,
      metadata: { name: 'quick', version: '1.0.0', description: '', tags: [] },
      spec: {
        pattern: 'react',
        model: {
          id: 'claude-sonnet-4',
          temperature: 0,
          max_tokens: null,
          region: null,
          cache: false,
          thinking_budget: null,
          fallbacks: [],
        },
        system_prompt: { inline: '', soul: false, base: '' },
        tools: ['calculator'],
        skills: [],
        mcp_servers: [],
        peers: [],
        containers: [],
        queues: [],
        sandboxes: [],
        browser_tools: [],
        sub_agents: [],
        aggregator_prompt: '',
        max_turns: 4,
        memory: { checkpointer: 'do', store: 'vectorize' },
        auth: {
          inbound: { schemes: [], required_scopes: [], allow_anonymous: true },
          outbound: { providers: [] },
        },
        a2a: { publish: false, capabilities: [] },
        observability: { trace: true, metrics: [] },
        execution: { mode: 'transient', resume_token_ttl_seconds: null },
        policies: [],
        limits: {
          max_tool_calls: null,
          max_wall_clock_seconds: null,
          max_peer_hops: null,
          max_input_tokens: null,
          max_output_tokens: null,
          precount: false,
        },
        guardrails: { providers: [], block_on_match: false, targets: ['input', 'output'] },
        approvals: [],
        recursion_limit: null,
      },
    },
  });

export type Manifest = z.infer<typeof ManifestSchema>;
export type Metadata = z.infer<typeof Metadata>;
export type Model = z.infer<typeof Model>;
export type SkillRef = z.infer<typeof SkillRef>;
export type McpServerRef = z.infer<typeof McpServerRef>;
export type A2APeerRef = z.infer<typeof A2APeerRef>;
export type ContainerRef = z.infer<typeof ContainerRef>;
export type QueueRef = z.infer<typeof QueueRef>;
export type SandboxRef = z.infer<typeof SandboxRef>;
export type BrowserToolRef = z.infer<typeof BrowserToolRef>;
