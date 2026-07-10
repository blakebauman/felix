/**
 * Wire types mirrored from the Felix harness so the client never invents its
 * own shapes:
 *   - ChatMessage / ChatRequest → src/api/chat.ts
 *   - StreamEvent               → src/api/openapi-shared.ts (StreamEventSchema)
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** An image attached to a user message (multimodal/vision input). */
export interface ImageAttachment {
  /** Data URL (`data:<mime>;base64,…`) or remote `https://` URL. */
  url: string;
  media_type: string;
  filename?: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Image attachments on a user turn (mapped to provider vision blocks). */
  attachments?: ImageAttachment[];
}

/** Cumulative token usage for one turn (all model sub-calls summed). */
export interface TokenUsage {
  input: number;
  output: number;
}

/** One `data: <json>` line from POST /chat/stream. */
export type StreamEvent =
  | { event: 'on_chat_model_stream'; data: { chunk: { content: string } } }
  | { event: 'on_tool_start'; data: { name: string; input: unknown } }
  | { event: 'on_tool_end'; data: { name: string; output: unknown } }
  | { event: 'on_chain_end'; data: { output?: { usage?: TokenUsage } } }
  | { event: 'on_error'; data: { message: string } };

/** A finished or in-flight tool call, rendered inline in the transcript. */
export interface ToolCall {
  name: string;
  input?: unknown;
  output?: unknown;
  done: boolean;
}

/** A turn in the UI transcript. Assistant turns may carry inline tool calls. */
export interface Turn {
  id: string;
  role: Exclude<Role, 'tool' | 'system'>;
  content: string;
  tools?: ToolCall[];
  /** Image attachments on a user turn (rendered as thumbnails). */
  attachments?: ImageAttachment[];
  /** Set on assistant turns from the terminal `on_chain_end` usage payload. */
  usage?: TokenUsage;
}

export type Variant = 'stable' | 'canary';

/** One event from GET /chat/history/{thread_id} (the ConversationDO log). */
export interface SessionEvent {
  seq: number;
  ts?: number;
  kind: 'message' | 'tool_result' | 'tool_call' | 'thinking' | 'audit';
  role?: Role;
  content?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

/** GET /chat/history/{thread_id} response. */
export interface ThreadHistory {
  events: SessionEvent[];
  head: number;
}

// --- Harness-parity surfaces (Inspector panel) ---
// Shapes mirror src/api/{audit,approvals,plans}.ts in the orchestrator.

/** One row from GET /audit. */
export interface AuditEvent {
  id: string;
  tenant_id: string;
  ts: number;
  event_type: string;
  manifest_id: string;
  principal_subject: string;
  status: string;
  payload: Record<string, unknown>;
}

/** One row from GET /approvals. */
export interface ApprovalRequest {
  id: string;
  tenant_id: string;
  manifest_id: string;
  tool_name: string;
  call_signature: string;
  args: Record<string, unknown>;
  principal_subject: string;
  status: 'pending' | 'approved' | 'denied';
  created_at: number;
  decided_at: number | null;
  decided_by: string;
  decision_note: string;
  edited_args: Record<string, unknown> | null;
}

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';

export interface PlanStep {
  id: string;
  description: string;
  status: PlanStepStatus;
  result: string;
}

/** One row from GET /plans. */
export interface Plan {
  id: string;
  tenant_id: string;
  manifest_id: string;
  title: string;
  steps: PlanStep[];
  created_at: number;
  updated_at: number;
}

/** One row from GET /audit/metrics — a (tool, transport, status) rollup. */
export interface ToolMetricsRow {
  manifest_id: string;
  tool: string;
  transport: string;
  status: string;
  error_code: string | null;
  count: number;
  avg_duration_ms: number | null;
}

/** GET /audit/metrics response. */
export interface ToolMetrics {
  since: number;
  until: number;
  rows: ToolMetricsRow[];
}

// --- Eval harness (/eval) ---
// Shapes mirror src/eval/types.ts. The UI authors a simplified rubric
// (criteria + must_include + threshold); the harness fills rubric defaults.

export interface Rubric {
  criteria?: string;
  must_include?: string[];
  must_not_include?: string[];
  pass_threshold?: number;
}

export interface EvalDataset {
  name: string;
  description: string;
  created_at: number;
}

export interface EvalDatasetItem {
  dataset_name: string;
  item_id: string;
  user_input: string;
  rubric: Rubric;
  created_at: number;
}

export interface ItemScore {
  item_id: string;
  score: number;
  verdict: 'pass' | 'fail';
  reasoning: string;
  response: string;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tool_call_count?: number | null;
  duration_ms?: number | null;
}

export interface EvalRun {
  id: string;
  dataset_name: string;
  candidate_manifest: string;
  started_at: number;
  finished_at: number | null;
  status: 'in_progress' | 'completed' | 'failed';
  pass_count: number;
  fail_count: number;
  scores: ItemScore[];
}

/** POST /eval/datasets/{name}/run response. */
export interface EvalRunSummary {
  run_id: string;
  pass_count: number;
  fail_count: number;
  pass_rate: number;
}

// --- Manifest lifecycle (/manifests) ---
// Shapes mirror src/api/manifests.ts. Tenant-managed manifests live in D1 as an
// append-only version log with an active pointer + optional canary pointer.

/** One row from GET /manifests — an active tenant-managed manifest. */
export interface ManifestSummary {
  name: string;
  active_version: number | null;
  canary_version?: number | null;
  canary_weight?: number;
  updated_at?: number;
}

/** One version in GET /manifests/{name}/versions. */
export interface ManifestVersionSummary {
  version: number;
  created_at: number;
  created_by: string;
  comment: string;
  active: boolean;
}

/** GET /manifests/{name}/versions response. */
export interface ManifestVersionList {
  name: string;
  active_version: number | null;
  versions: ManifestVersionSummary[];
}

/** GET /manifests/{name} — resolved through the 4-layer chain. */
export interface ResolvedManifest {
  name: string;
  source: 'tenant_d1' | 'tenant_r2' | 'global_r2' | 'bundled';
  version: number | null;
  manifest: unknown;
}

/** Canary/rollback/activate response (the active pointer state). */
export interface ManifestPointer {
  name: string;
  active_version: number;
  canary_version: number | null;
  canary_weight: number;
  updated_at: number;
}

// --- Scheduled jobs (/jobs) ---
// Shapes mirror src/jobs/models.ts. A job is a persistent, tenant-scoped record
// the cron sweep invokes on its `schedule`; it can also be triggered manually.

export interface JobRecord {
  tenant_id: string;
  name: string;
  schedule: string;
  manifest_id: string;
  last_run_at?: number | null;
  next_run_at?: number | null;
  last_status: string;
  last_error: string;
  created_at: number;
  payload: Record<string, unknown>;
}

// --- A2A discovery card (/.well-known/agent-card.json) ---
// Shape mirrors src/a2a/card.ts. Built for the orchestrator's *default* manifest
// — the peer-facing discovery document (endpoints, protocols, capabilities).

export interface AgentCard {
  name: string;
  description?: string;
  version?: string;
  protocols: string[];
  endpoints: Record<string, string>;
  auth: { schemes: string[]; required_scopes: string[]; allow_anonymous: boolean };
  capabilities: Array<{ id: string; description?: string; input_schema_ref?: string }>;
  containers: Array<{ name: string; description?: string; image?: string }>;
  queues: Array<{ name: string; description?: string }>;
  federation: { bundleVersion: string; issuer: string } | null;
}
