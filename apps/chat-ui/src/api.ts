/**
 * Thin client for the Felix surfaces the chat UI uses, all reached same-origin
 * under /api/* (Vite proxy in dev, proxy Worker in prod):
 *
 *   GET  /api/v1/models      → manifest list for the switcher
 *   POST /api/chat/stream    → SSE token stream + inline tool events (+ per-turn
 *                              token usage on the terminal on_chain_end frame)
 *   GET  /api/audit          → activity feed (Inspector)
 *   GET  /api/audit/metrics  → tool-call rollups (Inspector → Metrics)
 *   GET  /api/approvals      → pending HITL approvals (Inspector)
 *   POST /api/approvals/:id/decide → approve / deny
 *   GET  /api/plans          → plan/step progress (Inspector)
 *
 * The Inspector endpoints are tenant-scoped; an anonymous dev caller resolves
 * to tenant `default`, so they read back exactly what anonymous chat turns
 * produce. Behind real auth, send an Authorization header (see README).
 */

import { authHeaders, handleUnauthorized } from './lib/auth';
import type {
  AgentCard,
  ApprovalRequest,
  AuditEvent,
  ChatMessage,
  EvalDataset,
  EvalDatasetItem,
  EvalRun,
  EvalRunSummary,
  JobRecord,
  ManifestPointer,
  ManifestSummary,
  ManifestVersionList,
  Plan,
  ResolvedManifest,
  Rubric,
  StreamEvent,
  ThreadHistory,
  ToolMetrics,
  Variant,
} from './types';

/**
 * `fetch` for `/api/*` with the shared-key header attached. A 401 means the
 * key is missing/wrong/rotated — drop it and re-prompt (handleUnauthorized)
 * before the caller's own error handling runs.
 */
async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(input, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...authHeaders() },
  });
  if (res.status === 401) handleUnauthorized();
  return res;
}

/** GET /v1/models → manifest names for the dropdown. */
export async function listManifests(signal?: AbortSignal): Promise<string[]> {
  const res = await apiFetch('/api/v1/models', { signal });
  if (!res.ok) throw new Error(`models: ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => m.id);
}

export interface StreamHandlers {
  /** Header arrived; carries the resolved manifest variant (stable/canary). */
  onVariant?: (variant: Variant) => void;
  onEvent: (event: StreamEvent) => void;
}

export interface StreamArgs {
  manifest: string;
  messages: ChatMessage[];
  threadId?: string;
  signal?: AbortSignal;
}

/**
 * POST /chat/stream and dispatch each `data: <json>` line. Resolves when the
 * server emits `data: [DONE]`. The SSE framing (one event per `\n\n`) is
 * decoded with a carry buffer so events split across network chunks are not
 * dropped — same discipline the harness uses on its own SSE reads.
 */
export async function streamChat(args: StreamArgs, handlers: StreamHandlers): Promise<void> {
  const res = await apiFetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      manifest: args.manifest,
      messages: args.messages,
      ...(args.threadId ? { thread_id: args.threadId } : {}),
    }),
    signal: args.signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`chat/stream: ${res.status} ${detail.slice(0, 200)}`);
  }

  // x-manifest-variant is set on every response (defaults to 'stable').
  const variant = res.headers.get('x-manifest-variant');
  if (variant === 'stable' || variant === 'canary') handlers.onVariant?.(variant);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Drain whole `data: ...\n\n` frames; leave any partial tail in buffer.
    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf('\n\n');

      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (payload === '[DONE]') return;

      try {
        handlers.onEvent(JSON.parse(payload) as StreamEvent);
      } catch {
        // Ignore unparseable frames rather than tearing down the stream.
      }
    }
  }
}

// --- Inspector REST helpers ---

/** GET /audit → newest-first activity feed (tool_call, judge_score, approval_*, plan_step, …). */
export async function listAudit(
  opts: { status?: string; limit?: number } = {},
): Promise<AuditEvent[]> {
  const q = new URLSearchParams();
  if (opts.status) q.set('status', opts.status);
  q.set('limit', String(opts.limit ?? 50));
  const res = await apiFetch(`/api/audit?${q}`);
  if (!res.ok) throw new Error(`audit: ${res.status}`);
  const body = (await res.json()) as { events?: AuditEvent[] };
  return body.events ?? [];
}

/** GET /approvals?status=… → human-in-the-loop queue. */
export async function listApprovals(
  status: ApprovalRequest['status'] = 'pending',
): Promise<ApprovalRequest[]> {
  const res = await apiFetch(`/api/approvals?status=${status}`);
  if (!res.ok) throw new Error(`approvals: ${res.status}`);
  const body = (await res.json()) as { requests?: ApprovalRequest[] };
  return body.requests ?? [];
}

/** POST /approvals/:id/decide → approve or deny a gated tool call. */
export async function decideApproval(
  id: string,
  decision: { status: 'approved' | 'denied'; note?: string },
): Promise<ApprovalRequest> {
  const res = await apiFetch(`/api/approvals/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(decision),
  });
  if (!res.ok) throw new Error(`decide: ${res.status}`);
  return (await res.json()) as ApprovalRequest;
}

/** GET /plans → plan/step progress (populated by the `deep` pattern). */
export async function listPlans(limit = 25): Promise<Plan[]> {
  const res = await apiFetch(`/api/plans?limit=${limit}`);
  if (!res.ok) throw new Error(`plans: ${res.status}`);
  const body = (await res.json()) as { plans?: Plan[] };
  return body.plans ?? [];
}

/**
 * GET /audit/metrics → tool-call rollups for a window. Aggregates `tool_call`
 * audit rows by `(tool, transport, status, error_code)`; defaults to the last
 * hour server-side. We pass an explicit `since` so the panel window is stable.
 */
export async function getToolMetrics(
  opts: { sinceMs?: number; limit?: number } = {},
): Promise<ToolMetrics> {
  const q = new URLSearchParams();
  if (opts.sinceMs) q.set('since', String(Date.now() - opts.sinceMs));
  q.set('limit', String(opts.limit ?? 200));
  const res = await apiFetch(`/api/audit/metrics?${q}`);
  if (!res.ok) throw new Error(`metrics: ${res.status}`);
  return (await res.json()) as ToolMetrics;
}

// --- Eval harness (/eval) ---

async function evalFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/api/eval${path}`, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`eval ${path}: ${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** GET /eval/datasets → the tenant's golden datasets. */
export async function listEvalDatasets(): Promise<EvalDataset[]> {
  const body = await evalFetch<{ datasets?: EvalDataset[] }>('/datasets');
  return body.datasets ?? [];
}

/** POST /eval/datasets → create a dataset. */
export async function createEvalDataset(name: string, description = ''): Promise<EvalDataset> {
  return evalFetch<EvalDataset>('/datasets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, description }),
  });
}

/** GET /eval/datasets/{name}/items → items in a dataset. */
export async function listEvalItems(dataset: string): Promise<EvalDatasetItem[]> {
  const body = await evalFetch<{ items?: EvalDatasetItem[] }>(
    `/datasets/${encodeURIComponent(dataset)}/items`,
  );
  return body.items ?? [];
}

/** POST /eval/datasets/{name}/items → append an item with a rubric. */
export async function addEvalItem(
  dataset: string,
  item: { user_input: string; rubric: Rubric },
): Promise<EvalDatasetItem> {
  return evalFetch<EvalDatasetItem>(`/datasets/${encodeURIComponent(dataset)}/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(item),
  });
}

/**
 * POST /eval/datasets/{name}/run → replay the dataset against a manifest and
 * judge each item. Synchronous: returns the summary; per-item scores come back
 * via getEvalRun(run_id). `deterministic_judge` skips the Workers-AI judge
 * (substring gates only) for environments without the AI binding.
 */
export async function runEvalDataset(
  dataset: string,
  candidateManifest: string,
  deterministicJudge = false,
): Promise<EvalRunSummary> {
  return evalFetch<EvalRunSummary>(`/datasets/${encodeURIComponent(dataset)}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      candidate_manifest: candidateManifest,
      deterministic_judge: deterministicJudge,
    }),
  });
}

/** GET /eval/runs?dataset=… → runs newest first. */
export async function listEvalRuns(dataset?: string, limit = 25): Promise<EvalRun[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (dataset) q.set('dataset', dataset);
  const body = await evalFetch<{ runs?: EvalRun[] }>(`/runs?${q}`);
  return body.runs ?? [];
}

/** GET /eval/runs/{id} → one run with per-item scores. */
export async function getEvalRun(id: string): Promise<EvalRun> {
  return evalFetch<EvalRun>(`/runs/${encodeURIComponent(id)}`);
}

// --- Manifest lifecycle (/manifests) ---
//
// Writes (create/activate/canary/rollback) require the `manifests:write` scope.
// In local dev (ENVIRONMENT=development, no JWT_VERIFIERS) the harness lets
// anonymous callers through, so the demo drives the full lifecycle unauthed.

async function manifestFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/api/manifests${path}`, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`manifests ${path}: ${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** GET /manifests → tenant-managed manifests (active pointer + canary state). */
export async function listTenantManifests(): Promise<ManifestSummary[]> {
  const body = await manifestFetch<{ manifests?: ManifestSummary[] }>('');
  return body.manifests ?? [];
}

/** GET /manifests/{name}/versions → the append-only version log. */
export async function listManifestVersions(name: string): Promise<ManifestVersionList> {
  return manifestFetch<ManifestVersionList>(`/${encodeURIComponent(name)}/versions`);
}

/** GET /manifests/{name}[?version=] → resolved manifest + which layer it came from. */
export async function getResolvedManifest(
  name: string,
  version?: number,
): Promise<ResolvedManifest> {
  const q = version ? `?version=${version}` : '';
  return manifestFetch<ResolvedManifest>(`/${encodeURIComponent(name)}${q}`);
}

/** POST /manifests/{name} → append a new version (activates by default). */
export async function createManifestVersion(
  name: string,
  manifest: unknown,
  comment = '',
): Promise<{ version: number; activated: boolean }> {
  return manifestFetch(`/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest, comment }),
  });
}

/** POST /manifests/{name}/activate → flip the active pointer (rollback to a version). */
export async function activateManifestVersion(
  name: string,
  version: number,
): Promise<ManifestPointer> {
  return manifestFetch<ManifestPointer>(`/${encodeURIComponent(name)}/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version }),
  });
}

/** POST /manifests/{name}/canary → route `weight`% of traffic to `version` (null clears). */
export async function setManifestCanary(
  name: string,
  canaryVersion: number | null,
  canaryWeight: number,
): Promise<ManifestPointer> {
  return manifestFetch<ManifestPointer>(`/${encodeURIComponent(name)}/canary`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ canary_version: canaryVersion, canary_weight: canaryWeight }),
  });
}

/**
 * POST /manifests/{name}/rollback → zero the canary weight. `clearVersion` also
 * drops the canary_version pointer; default keeps it pinned for a retry.
 */
export async function rollbackManifestCanary(
  name: string,
  clearVersion = false,
): Promise<ManifestPointer> {
  return manifestFetch<ManifestPointer>(`/${encodeURIComponent(name)}/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clear_version: clearVersion }),
  });
}

// --- Scheduled jobs (/jobs) ---
//
// The cron sweep (jobs/cron.ts) invokes each job's manifest on its schedule;
// jobs can also be triggered manually. Tenant-scoped to `default` anonymously.

/** GET /jobs/list → the tenant's persistent job registry. */
export async function listJobs(): Promise<JobRecord[]> {
  const res = await apiFetch('/api/jobs/list');
  if (!res.ok) throw new Error(`jobs: ${res.status}`);
  const body = (await res.json()) as { jobs?: JobRecord[] };
  return body.jobs ?? [];
}

/** POST /jobs → create/upsert a job. Empty `schedule` = manual-only. */
export async function createJob(job: {
  name: string;
  schedule?: string;
  manifest_id?: string;
  payload?: Record<string, unknown>;
}): Promise<JobRecord> {
  const res = await apiFetch('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(job),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`create job: ${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as JobRecord;
}

/** POST /jobs/run/{name} → trigger a job now (records a `job_run` audit event). */
export async function runJob(name: string): Promise<void> {
  const res = await apiFetch(`/api/jobs/run/${encodeURIComponent(name)}`, { method: 'POST' });
  if (!res.ok) throw new Error(`run job: ${res.status}`);
}

// --- A2A discovery card (/.well-known/agent-card.json) ---

/**
 * GET /.well-known/agent-card.json → the orchestrator's A2A discovery document
 * for its *default* manifest (protocols, endpoints, declared capabilities). The
 * route is public (auth middleware skips /.well-known/*).
 */
export async function getAgentCard(): Promise<AgentCard> {
  const res = await apiFetch('/api/.well-known/agent-card.json');
  if (!res.ok) throw new Error(`agent-card: ${res.status}`);
  return (await res.json()) as AgentCard;
}

// --- Thread history (/chat/history/{thread_id}) ---

/**
 * GET /chat/history/{thread_id} → the server-side checkpointed transcript from
 * the thread's ConversationDO event log. Anonymous callers get this only in
 * local dev (the harness adds a dev fallthrough); behind auth it 401s. We use a
 * bare fetch (not apiFetch) so a 401 doesn't trip the shared-key reset/reload —
 * any non-OK simply means "no server history", and the caller falls back to the
 * localStorage transcript.
 */
export async function getThreadHistory(threadId: string): Promise<ThreadHistory | null> {
  try {
    const res = await fetch(`/api/chat/history/${encodeURIComponent(threadId)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    return (await res.json()) as ThreadHistory;
  } catch {
    return null;
  }
}

/** DELETE /chat/history/{thread_id} → erase the server transcript. Best-effort. */
export async function deleteThreadHistory(threadId: string): Promise<void> {
  try {
    await fetch(`/api/chat/history/${encodeURIComponent(threadId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
  } catch {
    // best-effort; the local copy is the source of truth in the demo
  }
}
