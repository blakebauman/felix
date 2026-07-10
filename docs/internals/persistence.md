# Persistence

The data stores Felix uses, what lives in each, and the tenant-scoping conventions.

## D1

Schema lives in `migrations/0001_init.sql` through `0018_dynamic_pricing.sql`. The harness core is `0001`–`0005` (audit/plans/jobs/approvals/skills/oauth, manifests, eval, canary); `0006`–`0018` add the commerce layer (products/orders, ACP sessions, brands + domains, data sources, B2B accounts/quotes/pricing/billing, GEO, consent + attribution, personalization, dynamic pricing — documented in [commerce.md](commerce.md#data-model--configuration)).

Every table that holds tenant-owned data leads its primary key with `tenant_id` — `(tenant_id, id)` in the common case, with natural composites where the entity demands it (`(tenant_id, name)` for jobs, `(tenant_id, name, version)` for manifests, `(tenant_id, account_id, product_id)` for contract prices, `(tenant_id, thread_id)` for customer sessions / abandoned carts) — so cross-tenant reads/writes require an explicit `WHERE tenant_id = ?` clause. The one deliberate exception is `brand_domains`, keyed by `(host)` alone: it routes anonymous public storefront traffic to a brand before any tenant is known.

### audit_events

```sql
CREATE TABLE audit_events (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  event_type      TEXT NOT NULL,
  manifest_id     TEXT NOT NULL DEFAULT '',
  principal_subj  TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT '',
  payload_json    TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_audit_tenant_ts        ON audit_events (tenant_id, ts DESC);
CREATE INDEX idx_audit_tenant_status_ts ON audit_events (tenant_id, status, ts DESC);
```

Append-only. Producer writes through `AUDIT_QUEUE`; the queue consumer batches up to 50 events per `DB.batch()` insert. Payloads are passed through `redactSecrets` before persistence.

Query patterns:
- `WHERE tenant_id = ? ORDER BY ts DESC LIMIT ?` (list)
- `WHERE tenant_id = ? AND status = ? ORDER BY ts DESC LIMIT ?` (filtered list)

### plans

```sql
CREATE TABLE plans (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  manifest_id TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  plan_json   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_plans_tenant_updated ON plans (tenant_id, updated_at DESC);
```

The full plan (title + steps array) is serialized as JSON in `plan_json`. Steps are not denormalized into a separate table because they're always read together. 30-day TTL via `expires_at` (set by `plan_create`).

### jobs

Initial shape from `0001_init.sql` had `name` as the sole primary key, which let any authenticated caller list/run another tenant's jobs. `migrations/0002_harden.sql` rewrites the table (SQLite can't `ALTER` a PRIMARY KEY in place) so the PK is now `(tenant_id, name)`, adds a `next_run_at` column, and adds a partial index for the scheduled sweep:

```sql
CREATE TABLE jobs (
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  schedule     TEXT NOT NULL DEFAULT '',
  manifest_id  TEXT NOT NULL DEFAULT '',
  last_run_at  INTEGER,
  next_run_at  INTEGER,
  last_status  TEXT NOT NULL DEFAULT '',
  last_error   TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, name)
);
CREATE INDEX idx_jobs_tenant_name ON jobs (tenant_id, name);
CREATE INDEX idx_jobs_next_run    ON jobs (next_run_at)
  WHERE schedule != '' AND next_run_at IS NOT NULL;
```

Pre-0002 rows are folded under `tenant_id = 'default'` during the rewrite. `src/jobs/store.ts` filters every read/write on `tenant_id`; the scheduled-sweep query (`listDueJobs`) is the one global read — it picks up due rows across all tenants and the cron handler enforces the per-tenant boundary by running each job under that tenant's context.

### approvals

```sql
CREATE TABLE approvals (
  id               TEXT NOT NULL,
  tenant_id        TEXT NOT NULL,
  manifest_id      TEXT NOT NULL DEFAULT '',
  tool_name        TEXT NOT NULL,
  call_signature   TEXT NOT NULL,
  args_json        TEXT NOT NULL DEFAULT '{}',
  principal_subj   TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'pending',
  created_at       INTEGER NOT NULL,
  decided_at       INTEGER,
  decided_by       TEXT NOT NULL DEFAULT '',
  decision_note    TEXT NOT NULL DEFAULT '',
  edited_args_json TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX uq_approval_signature
  ON approvals (tenant_id, manifest_id, tool_name, call_signature);
CREATE INDEX idx_approvals_tenant_status
  ON approvals (tenant_id, status, created_at DESC);
```

The unique index on `(tenant_id, manifest_id, tool_name, call_signature)` is what makes approval retry idempotent: a second invocation with the same arguments deterministically hashes to the same signature and finds the existing row.

`call_signature = SHA-256(${manifestId}|${toolName}|${canonicalize(args)})`, where `canonicalize` sorts keys before serializing. `args_json` is the post-redaction copy of arguments — secrets are stripped before storage.

### skill_activation

```sql
CREATE TABLE skill_activation (
  tenant_id     TEXT NOT NULL,
  manifest_id   TEXT NOT NULL,
  active_skills TEXT NOT NULL DEFAULT '[]',  -- JSON array of skill names
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, manifest_id)
);
```

The overlay is restriction-only. `null` row (no entry) means "no overlay, all declared skills active". An empty array means "everything off". A populated array is the intersection with the manifest's declared skills — the overlay can never enable a skill the manifest didn't declare.

### oauth_token_cache

```sql
CREATE TABLE oauth_token_cache (
  cache_key    TEXT PRIMARY KEY,         -- "provider:subject"
  access_token TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  scope        TEXT NOT NULL DEFAULT ''
);
```

`access_token` is encrypted at rest with `OAUTH_CACHE_KEY` (AES-256-GCM). A 96-bit IV is generated per ciphertext and stored as `base64(iv || ciphertext_with_tag)`. In dev a missing key falls back to plaintext with a one-shot warning; in staging/production a missing key fails closed.

### Commerce tables (0006–0018)

The commerce layer adds ~25 tables following the same conventions; their shapes and semantics are documented alongside the features in [commerce.md](commerce.md). Highlights that affect persistence reasoning:

- **The cart is not a table.** It lives in the ConversationDO session log as the latest `kind: 'audit'` event with `metadata: { type: 'cart', pinned: true }` (`src/commerce/cart-session.ts`) — highest `seq` wins, and render strategies skip audit events so it never enters the model window.
- `consents` and `behavior_events` are **append-only** streams (consent withdrawal is a new `granted = 0` row, never an update).
- `orders` is written only by verified payment paths (Stripe webhook, ACP complete, B2B convert), with deterministic ids on the ACP path for idempotency.
- `data_sources` (the entity seam config) can redirect reads of B2B entities to federated/synced 3p systems — D1 is the default `native` backend, not an assumption.

## KV (`CACHE`)

In-memory-style key/value store. Used for:
- **JWKS cache** — `jose` library handles its own caching with a 1-hour TTL; KV-backed cache is a future refinement.
- **Outbound OAuth token cache** — same purpose as the D1 table but for short-lived shared tokens. The two coexist; the D1 table is the durable cache, KV is the in-flight one.
- **Manifest cache** — when async R2 overrides are in play.

## R2 (`BUNDLES`)

Three things live here:

1. **Signed `PolicyBundle`** at the key in `POLICY_BUNDLE_KEY` (default `bundles/active.json`). Ed25519 signature verified by `verifyBundleSignature` (`src/policy/bundle.ts`) against the raw 32-byte public key in `POLICY_BUNDLE_PUBKEY`. Staging/production refuse to install an unsigned or tampered bundle (the previous active bundle stays in place); development logs a warning and loads anyway so local stacks can iterate without signing keys.
2. **Tenant-scoped manifest overrides** at `manifests/<tenant_id>/<name>.json`. Power-user path for bulk pre-population via `wrangler r2 object put` — the `/manifests` REST API does not write here. Loses to a populated tenant D1 row; wins over the global R2 override and the bundled set.
3. **Global manifest overrides** at `manifests/<name>.json`. Affects every tenant. Wins over bundled, loses to either tenant layer.

R2 is the authoritative federation pipe. For tenant-specific manifest changes, the canonical surface is the `/manifests` REST API (D1-backed, append-only, audited). Use R2 keys when you need bulk seeding or a deploy-without-redeploy escape hatch.

## D1 (`DB`) — manifests + manifest_active

Two tables added in `migrations/0003_manifests.sql` back the tenant-managed manifest store:

```sql
CREATE TABLE manifests (
  tenant_id      TEXT NOT NULL,
  name           TEXT NOT NULL,
  version        INTEGER NOT NULL,         -- monotonic per (tenant_id, name)
  manifest_json  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  created_by     TEXT NOT NULL DEFAULT '',
  comment        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, name, version)
);

CREATE TABLE manifest_active (
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, name)
);
```

`manifests` is append-only — every `POST /manifests/:name` allocates the next version and inserts a row; rollback flips the `manifest_active` pointer in a `DB.batch()` together with the version insert. Reads go through `resolveManifest` (`src/manifests/resolver.ts`), which caches the active pointer per isolate for 30s and the immutable version blobs forever.

### manifest_active — canary columns

`migrations/0005_manifest_canary.sql` extends `manifest_active` with two nullable columns:

```sql
ALTER TABLE manifest_active ADD COLUMN canary_version INTEGER;
ALTER TABLE manifest_active ADD COLUMN canary_weight  INTEGER NOT NULL DEFAULT 0;
```

When `canary_version` is set and `canary_weight > 0`, `resolveManifest` calls `pickVariant({ tenant_id, thread_id, manifest_name, stable_version, canary_version, canary_weight })` which hashes the tuple with SHA-256 and routes the request to the canary if the first 4 bytes mod 100 falls under `canary_weight`. Including the version numbers in the hash means a redeploy of the canary reshuffles routing — useful for staged ramps but means thread continuity isn't guaranteed across canary edits.

The resolver attaches `variant: 'stable' | 'canary'` to `ResolvedManifest`; routes surface it as `x-manifest-variant` on the response. Auto-rollback (`src/jobs/anomaly-detector.ts`) sets `canary_weight = 0` atomically when the anomaly cron flags a canary version.

### eval_datasets / eval_dataset_items / eval_runs

`migrations/0004_eval.sql` adds three tables backing the eval harness:

```sql
CREATE TABLE eval_datasets (
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE eval_dataset_items (
  tenant_id    TEXT NOT NULL,
  dataset_name TEXT NOT NULL,
  id           TEXT NOT NULL,
  input_json   TEXT NOT NULL,           -- { messages: ChatMessage[] }
  rubric_json  TEXT NOT NULL,           -- { must_include?, must_not_include?, judge?, trajectory? }
  cost_target  REAL,                    -- max tokens-equivalent before flag
  tags         TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, dataset_name, id)
);

CREATE TABLE eval_runs (
  tenant_id    TEXT NOT NULL,
  id           TEXT NOT NULL,
  dataset_name TEXT NOT NULL,
  manifest_id  TEXT NOT NULL,
  variant      TEXT NOT NULL DEFAULT 'stable',
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  summary_json TEXT NOT NULL DEFAULT '{}',  -- { pass_rate, cost_avg, judge_panel, regressions[] }
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_eval_runs_dataset ON eval_runs (tenant_id, dataset_name, created_at DESC);
```

Items snapshot the input + rubric verbatim — running an item later replays exactly what was scored before. Runs land a single summary row; item-level scoring lives in `payload_json` of the paired `eval_run` audit event so we don't fan out a fourth eval table per item.

## Vectorize (`MEMORY_VEC`)

768-dimensional cosine index. Embeddings come from `@cf/baai/bge-base-en-v1.5` via the native `env.AI` binding.

Used by the Vectorize-backed store in `src/memory/store.ts` when `manifest.memory.store` resolves to `vectorize`:

| Op | Behavior |
|---|---|
| `remember(text, kind)` | Embed, upsert with metadata `{ tenant, manifest, kind, ts, text }`. |
| `recall(query, k)` | Embed query, top-K query filtered by `{ tenant }`. |
| `forget(id)` | Lookup, verify tenant ownership, delete. |

Every read is tenant-scoped. Every write tags the tenant. There is no cross-tenant recall path.

The builder auto-injects two tools (`memory_remember`, `memory_recall`) when this store is enabled, so manifest authors never need to declare them.

### Three additional Vectorize use cases

The same `MEMORY_VEC` index also backs:

- **`semantic:N` session strategy** (`src/session/semantic-strategy.ts`) — on each render, embed the most recent user message and pull the top-N most relevant prior events from the session log scored against a per-thread namespace. Anchor messages (`metadata.pinned === true`) are always included regardless of score.
- **JIT tool retrieval** (`src/tools/retrieval.ts`) — `selectTopKTools(tools, messages, opts)` embeds the conversation tail and each tool's `description + name` once at build time (cached in an isolate-local LRU), returns the top-K most relevant tools per react iteration. The full tool map is still available for dispatch so a hallucinated tool name routes through the existing unknown-tool audit path.
- **Procedural memory** (`src/memory/procedural.ts`) — `storeProcedure(...)` writes successful past plans tagged with the manifest; `recall_procedure` (auto-injected when `spec.procedural_memory.enabled`) lets the model pull few-shot examples from the same index. Filtered by `{ tenant, manifest, kind: 'procedural' }`.

All three share the same 768-dim BGE embedding pipeline. No additional Vectorize bindings are needed.

## R2 (`BUNDLES`) — artifact spill

When `spec.artifacts.enabled` is true and a tool result exceeds `spec.artifacts.threshold_chars` (default 8000), react writes it to R2 at `artifacts/<tenant_id>/<thread_id>/<tool_call_id>.txt` and substitutes a chatty stub whose preview is the first `preview_chars` (default 200) of the content:

```
[artifact:<tool_call_id>] preview…
[truncated — <N> chars total. Call fetch_artifact({ref: "<tool_call_id>", start, length}) to read a window.]
```

`fetch_artifact` (auto-injected when artifacts are enabled) reads the R2 object and returns a byte window — `start` (default 0) and `length` (default `default_window_chars` = 4000, capped at `max_window_chars` = 16000). Writes carry `customMetadata: { tenant_id, thread_id }` and are idempotent on `tool_call_id` (a retried turn overwrites in place); a spill failure falls back to returning the original content inline rather than the stub. The mechanism keeps the working set small in long tool-loop runs without sacrificing recoverability.

## Queue (`AUDIT_QUEUE`)

Producer: `recordEvent(opts)` in `src/audit/store.ts` reads the current `RequestContext` for env/execCtx/limit state and fires `queue.send(event)` wrapped in `execCtx.waitUntil` so it's best-effort and never blocks the request path. Falls back to a single direct insert if the queue binding is absent (unit tests), or to `console.log` when no `RequestContext` is installed at all (which is why `scheduled` and `queue` handlers in `src/index.ts` install an anonymous context before running their bodies).

Consumer: `src/index.ts:queue` handler. Bound in `wrangler.jsonc`:

```jsonc
"queues": {
  "producers": [{ "binding": "AUDIT_QUEUE", "queue": "felix-audit" }],
  "consumers": [
    { "queue": "felix-audit", "max_batch_size": 50, "max_batch_timeout": 5 }
  ]
}
```

The consumer tries a single `DB.batch()` insert for the whole batch; on failure it falls back to per-row inserts so a single poison event can't starve audit writes for every tenant.

Per-request audit cap: 200 events (tracked on `LimitState.auditCount`). When exceeded, the producer emits one `audit_truncated` marker (and an `orchestrator_audit_dropped` counter) and silently drops the rest.

A second queue, `JOBS_QUEUE` (`felix-jobs`), backs the `transport: queue` tool seam (`spec.queues[].queue_binding`). Its consumer is deliberately external to Felix (see `examples/queue-consumer/`); the producer binding is declared in `wrangler.jsonc` comments and enabled per deployment.

### Async tool resumption (queue transport)

`QueueExecutor` (`transport: queue`, [`src/tools/queue-executor.ts`](../../src/tools/queue-executor.ts)) is the dispatch half of an async-tool protocol that uses the session log as the rendezvous point. The full path:

1. The model emits an assistant turn carrying `tool_calls: [{ id: 'tc1', name: '…', args: {…} }]`. The react/deep loop persists that turn as a session event.
2. `QueueExecutor.execute(args, ctx)` runs in the request:
   - Reads `tenantId` / `threadId` from `RequestContext` and `toolCallId` from `ToolInvocationCtx`.
   - Calls `queue.send({ job_id, thread_id, tool_call_id, tool, tenant_id, manifest_id, arguments, deadline_ms? })`.
   - Returns the stub `"[queued] tool '<name>' is running asynchronously (job_id=<id>). Tell the user the result will arrive on the next turn; they can reconnect with tasks/resubscribe to wait for it."`
3. The model sees the stub as a normal tool result and replies to the user. The loop ends.
4. A separate consumer — a Cloudflare Queue consumer, scheduled Worker, or external service; **deliberately not part of Felix** — reads the queue message, does the work, and appends a `kind: 'tool_result'` event back to `ConversationDO` for `thread_id`, keyed to `tool_call_id`.
5. When the client reconnects via `tasks/resubscribe`, `session.wake()` reports `pendingToolCalls: []` (the cycle is resolved). The next model call renders the resolved `tool_result` through the strategy and the model produces the final answer.

The contract is just the queue message shape and the convention that the consumer writes a `tool_result` with the same `tool_call_id`. That convention is what makes `wake()` see the resolution — no separate completion-tracking table is needed.

Failure modes:
- `queue.send` throws → stub becomes `[queue error] …`. The model sees the error and decides how to handle it (typically: tell the user the system is degraded).
- `toolCallId` missing in ctx → executor returns `[queue error] … no tool_call_id …` and does **not** enqueue. A consumer-side result with no matching tool_call_id can never resolve, so refusing here is the safer default.
- Consumer never writes back → the assistant tool_call stays unresolved on the session. `wake()` keeps reporting it; the client can keep retrying `tasks/resubscribe` until it gives up. The orphan event is fine to leave in the log.

The protocol is pinned by [`tests/unit/queue_async_resume.test.ts`](../../tests/unit/queue_async_resume.test.ts).

## Durable Objects

See [architecture.md](architecture.md) for the inventory. Each DO is its own piece of state:

| Class | Key | Role |
|---|---|---|
| `ConversationDO` | `${tenantId}:${threadSuffix}` | Session event log per thread. Exposes `GET /events?from&to&limit&kinds`, `GET /head`, `POST /events`, `DELETE /events`. `blockConcurrencyWhile` on appends. Events are stored with monotonic `seq`, `kind` discriminator (`message` / `tool_result` / `tool_call` / `thinking` / `audit`), the message-shaped payload, and optional `metadata`. Legacy `messages: StoredMessage[]` storage is migrated to events on first read. The `Session` / `SessionStrategy` abstraction (`src/session/`) sits on top — patterns never read the DO directly. `Session.wake()` analyses the event log to compute the resume point for crash recovery (used by A2A `tasks/resubscribe`). |
| `A2ATaskDO` | `${tenantId}#${taskId}` | A2A task lifecycle. |
| `ApprovalsDO` | `${tenantId}#${approvalId}` | Critical section for `decide` writes; D1 stays the system of record. |
| `FederationDO` | `singleton` | Process-singleton cache of the active `PolicyBundle`. |

The leading tenant prefix (or `singleton` for federation) makes cross-tenant access structurally impossible — there is no DO key namespace a caller can construct that maps to another tenant's DO.

## Composite-key invariant

Three rules to keep tenant isolation working:

1. **Every new D1 table for tenant-owned data uses `PRIMARY KEY (tenant_id, id)`** and an index `(tenant_id, ts DESC)` for time-ordered reads.
2. **Every query has `WHERE tenant_id = ?`.** Stores in `src/*/store.ts` enforce this — there is no helper that elides it.
3. **Every DO id encodes the tenant prefix.** The two delimiters used by Felix's internal namespaces (`:` for ConversationDO, `#` for A2A and approvals) are rejected from caller-supplied suffixes so they cannot be smuggled in.
