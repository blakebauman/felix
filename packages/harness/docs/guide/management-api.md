---
description: "Tenant-scoped management endpoints — audit, plans, jobs, approvals, manifests, eval — with scope requirements and curl examples."
---

# Management API

Tenant-scoped management endpoints for the audit log (`/audit` + `/audit/metrics`), plan store, scheduled jobs, human-in-the-loop approvals queue, tenant-managed manifests (`/manifests`), and golden-dataset evals (`/eval`). Authorization is two-layer:

1. **Tenant scoping** — every route constrains queries to `principal.tenantId`, so there is no cross-tenant query path, even for an authenticated principal.
2. **Scopes** — every management route additionally requires a scope claim on the bearer token (`requireScope` in `src/auth/middleware.ts`). Anonymous callers get `401`; authenticated callers missing the scope get `403 {"error":"forbidden","missing_scopes":[...]}`. In `ENVIRONMENT=development` without verifiers configured the gate falls open so local probes work without minting tokens.

| Surface | Read scope | Write scope |
|---|---|---|
| `/audit`, `/audit/metrics` | `audit:read` | — |
| `/approvals` | `approvals:read` | `approvals:decide` (decide endpoint) |
| `/plans` | `plans:read` | — |
| `/jobs` | `jobs:read` | `jobs:write` |
| `/manifests` | `manifests:read` | `manifests:write` |
| `/eval` | `eval:read` | `eval:write` |
| `/commerce/consents`, `/commerce/attribution/*` | `consent:read` | — |
| `/geo` | tenant-scoped | `geo:write` |
| `/brands` | tenant-scoped | `brands:write` |
| `/b2b` (accounts, quotes, billing) | tenant-scoped | `b2b:write` |
| `/entities` | tenant-scoped | `entities:write` |

All routes return JSON. Rate limited at 100 req/60s per tenant. The commerce management surfaces (`/brands`, `/b2b`, `/entities`, `/geo`, consent/attribution) are covered in [the commerce docs](../../../commerce/docs/index.md).

:::note[Dev gate]
In `ENVIRONMENT=development` without JWT verifiers configured, scope gates fall open so local probes work without minting tokens. In staging and production the gate is strict — anonymous callers get `401`; authenticated callers missing the scope get `403 {"error":"forbidden","missing_scopes":[...]}`.
:::

Examples below use `$BASE_URL` — set it to your deployment (e.g. `export BASE_URL=http://localhost:8787` for `pnpm dev`, or `https://make.felix.run` in production).

> Formal request/response schemas live in `GET /openapi.json` and the Scalar UI at `GET /docs`. The prose tables below are the human-readable reference.

---

## Audit

### GET /audit

List recent audit events for the authenticated tenant.

**Query params**

| Param | Default | Notes |
|---|---|---|
| `status` | (unset) | Filter to one status, e.g. `denied`, `pending`, `matched`. |
| `limit` | 100 | Max rows. |

```bash
curl -s -H "Authorization: Bearer $JWT" \
  '$BASE_URL/audit?status=denied&limit=50' | jq
```

Response:

```json
{
  "events": [
    {
      "id": "uuid",
      "tenant_id": "acme",
      "ts": 1747100000123,
      "event_type": "policy_decision",
      "manifest_id": "research",
      "principal_subject": "user:alice",
      "status": "denied",
      "payload": { "policy_id": "write-paths", "tool": "notion__create_page", "missing_scopes": ["research:write"] }
    }
  ]
}
```

### Audit event types

Recorded by the runtime as side effects of governance and tool dispatch:

Every tool-related event (`tool_call`, `policy_decision`, `limit_exceeded`, `guardrail_block`, `judge_score`, `approval_request`, `approval_decision`) carries `transport` in its payload — the executor's transport label (`local` / `mcp` / `a2a` / `container` / `queue` / `sandbox` / `browser`). Tool-call rows additionally carry `error_code` (the `ToolErrorCode` taxonomy) on failures. The matching counters (`orchestrator_tool_calls`, `orchestrator_policy_decisions`, `orchestrator_limit_breaches`, `orchestrator_guardrail_blocks`, `orchestrator_judge_scores`, `orchestrator_approval_*`) carry the same labels. Slice an audit query or dashboard by transport / error_code to answer questions like "how many `container` tool calls failed today with `rate_limited`?" or "which transport ate the most peer-hop budget?"

| `event_type` | Emitted by | Common `status` values |
|---|---|---|
| `tool_call` | `react.ts` `dispatchToolCall` — one per tool invocation. Payload carries `{ tool, transport, args, output_preview?, error?, error_code?, duration_ms }`. A peer invocation is `tool_call` with `transport: 'a2a'`, not a separate event type. Skipped when a governance wrapper denied (the wrapper emits its own event below). | `ok`, `error` |
| `policy_decision` | `policy/wrap.ts` — payload `{ policy_id, tool, transport, missing_scopes, outcome }` | `denied` |
| `limit_exceeded` | `limits/wrap.ts` — payload `{ tool, transport?, limit, cap, observed }` (transport omitted for model-side breaches like preflight/cumulative token caps) | `denied` |
| `guardrail_block` | `guardrails/wrap.ts` (tool side, `surface: input`/`output`) and `guardrails/final-response.ts` (`surface: final_response`, no `tool`/`transport`) — payload `{ surface, matches, [tool, transport] }` | `matched`, `clean` |
| `judge_score` | `guardrails/judge-wrap.ts` (tool judges) + `guardrails/final-response.ts` (`source: 'final_response'`) + eval runner + reflect pattern. Payload `{ judge?, tool?, transport?, score, threshold?, reasoning, source? }`. The `source` field disambiguates: absent for the tool-side governance wrapper, `'final_response'` for a judge scoring the model's final answer, `'reflect'` for the reflection pattern's per-iteration scores, set by the eval runner when scoring dataset items. | `pass`, `fail` |
| `plan_step` | `plans/tools.ts` `plan_update_step` — one per step transition. Payload `{ plan_id, step_id, result_present }`. | `pending`, `in_progress`, `completed`, `skipped`, `failed` |
| `job_run` | Cron sweep + manual triggers | `scheduled`, `manual`, `error` |
| `approval_request` | `approvals/wrap.ts` first invocation — payload `{ approval_id, tool, transport }` | `pending` |
| `approval_decision` | `/approvals/:id/decide` and retry-time wrapper — payload `{ approval_id, tool, transport }` | `approved`, `denied`, `pending` |
| `checkpoint_failure` | Session `appendBatch` failed after retry | `failed` |
| `queue_dispatch` | `QueueExecutor` — payload `{ job_id, tool, tool_call_id, thread_id, deadline_ms? }` | `enqueued` |
| `queue_complete` | Emitted server-side on a successful `POST /internal/sessions/:thread_id/events` write-back (the route pairs the `tool_result` to an outstanding `queue_dispatch` first; unpaired or already-resolved → 409) — payload `{ tool, tool_call_id, thread_id, job_id? }`, `manifest_id` carried over from the paired dispatch | `ok` |
| `queue_expired` | Orphan-cleanup cron for unresolved `queue_dispatch` rows — payload `{ job_id, tool_call_id, thread_id, age_ms }` | `expired` |
| `manifest_created` | `POST /manifests/:name` | (none) |
| `manifest_activated` | `POST /manifests/:name/activate` (or implicit on create) | (none) |
| `manifest_deleted` | `DELETE /manifests/:name` or `/versions/:version` | (none) |
| `manifest_canary_set` | `POST /manifests/:name/canary` — payload `{ canary_version, canary_weight, stable_version }` | `<canary_weight>` |
| `manifest_canary_cleared` | `POST /manifests/:name/rollback` or auto-rollback — payload `{ canary_version_before?, canary_weight_before?, stable_version, clear_version? }` | `manual`, `auto_rollback` |
| `auto_rollback` | anomaly detector cron when a flagged manifest has an active canary | `rolled_back` |
| `anomaly_detected` | anomaly detector cron — payload `{ tool, error_code, recent_rate, baseline_rate, recent_count, window_ms }` | `alert` |
| `model_switch` | model client when a fallback or confidence escalation fires — payload `{ from, to, reason }` (`provider_error` or `low_confidence`) | `fallback`, `escalated` |
| `eval_run` | eval runner on completion (reserved) | (none) |
| `unhandled_error` | `app.onError` boundary | `error` |
| `commerce_order` | Stripe webhook on `checkout.session.completed` / ACP completion — payload `{ order_id, thread_id, amount_cents, channel, manifest_id }` | `paid` |
| `brand_provisioned` | `POST /brands` — payload `{ brand_id, name, domain }` | `ok` |
| `brand_catalog_import` | `POST /brands/:id/catalog` — payload `{ brand_id, product_count, error? }` | `ok`, `error` |
| `b2b_purchase_check` | `purchase_authority_check` tool / `POST /b2b/accounts/:id/purchase-check` — payload `{ account_id, buyer_id, amount_cents, reason }` | `allowed`, `requires_approval`, `blocked` |
| `b2b_quote` | Quote lifecycle tools (`create_quote`, `send_quote`, `accept_quote`, `convert_quote`) — payload `{ quote_id, account_id, amount_cents }` | `draft`, `sent`, `accepted`, `ordered` |
| `geo_observation` | GEO monitor cron per tracked query replay — payload `{ brand_id, query, engine, mentioned, rank?, competitors[] }` | `ok` |
| `consent_recorded` | `commerce_record_consent` tool / `POST /commerce/consents` — payload `{ thread_id, channel, terms_version }` | `granted`, `withdrawn` |
| `order_attributed` | Stripe webhook / ACP completion — payload `{ order_id, thread_id, channel, manifest_id, buyer_subject }` | `ok` |
| `cart_abandoned` | Abandoned-cart cron — payload `{ thread_id, customer_id?, recovery_webhook_sent }` | `detected` |

#### `audit_truncated` is a status, not an event type

The runtime caps audit events at 200 per request (`PER_REQUEST_AUDIT_CAP` in `src/audit/store.ts`). When the cap is hit, the next call to `recordEvent` emits one marker — carrying the **original `event_type`** of whatever was being recorded and `status: 'audit_truncated'` with payload `{ reason: 'per_request_cap', cap: 200 }`. Subsequent calls during the same request return silently with `status: 'dropped_after_truncation'` and are not persisted. To find truncation events for a tenant, query `GET /audit?status=audit_truncated`.

Audit events go through `AUDIT_QUEUE` and land in D1 via the batched `queue` consumer (≤50 per batch). Payloads are passed through `redactSecrets` before persistence — tokens, bearer headers, and similar are replaced with `[REDACTED]`.

---

## Approvals

### GET /approvals

List approval requests for the tenant.

**Query params**

| Param | Default | Notes |
|---|---|---|
| `status` | (unset) | `pending`, `approved`, `denied`. |
| `limit` | 100 | Max rows. |

```bash
curl -s -H "Authorization: Bearer $JWT" \
  '$BASE_URL/approvals?status=pending&limit=25' | jq
```

```json
{
  "requests": [
    {
      "id": "uuid",
      "tenant_id": "acme",
      "manifest_id": "research",
      "tool_name": "notion__create_page",
      "call_signature": "<sha256>",
      "args_json": "{ ...redacted... }",
      "principal_subj": "user:alice",
      "status": "pending",
      "created_at": 1747100000123
    }
  ]
}
```

`args_json` is the redacted version of the original arguments — secrets are stripped before persistence.

### GET /approvals/:id

Fetch one approval. Returns 404 if it doesn't belong to the caller's tenant.

```bash
curl -s -H "Authorization: Bearer $JWT" \
  $BASE_URL/approvals/<uuid> | jq
```

### POST /approvals/:id/decide

Approve or deny. The route pre-checks tenant ownership in D1 (returns 404 if not owned) and then routes the write through `ApprovalsDO` so concurrent decisions on the same id are serialized in a critical section.

**Body**

```json
{
  "status": "approved",
  "note": "Looks fine, ship it.",
  "edited_args": null
}
```

- `status` — `approved` or `denied`.
- `note` — free-form text persisted in `decision_note`.
- `edited_args` — optional. If supplied, the agent's next retry uses these args instead of the original. Useful for redacting or tightening arguments before allowing the call.

```bash
curl -s -X POST -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  $BASE_URL/approvals/<uuid>/decide \
  -d '{"status":"approved"}' | jq
```

Response is the updated `ApprovalRequest` row. An `approval_decision` audit event is emitted with `status: approved` or `status: denied`.

A decision is a **one-way transition**: deciding a request that is no longer `pending` (already approved or denied) changes nothing and returns `409 { "error": "already_decided", "detail": "<current status>" }`. This is what prevents an operator from flipping an approved request to denied — or re-approving it with different `edited_args` that a later retry would run on.

---

## Plans

### GET /plans

List plans for the tenant, ordered by `updated_at DESC`.

```bash
curl -s -H "Authorization: Bearer $JWT" \
  '$BASE_URL/plans?limit=20' | jq
```

```json
{
  "plans": [
    {
      "id": "uuid",
      "tenant_id": "acme",
      "manifest_id": "research",
      "title": "Investigate Q3 churn",
      "steps": [
        { "id": "s1", "description": "Pull churn data", "status": "completed", "result": "..." },
        { "id": "s2", "description": "Segment by region", "status": "in_progress", "result": "" }
      ],
      "created_at": 1747100000123,
      "updated_at": 1747100012345
    }
  ]
}
```

### GET /plans/:id

Fetch one plan with full steps.

```bash
curl -s -H "Authorization: Bearer $JWT" \
  $BASE_URL/plans/<uuid> | jq
```

Plans are written and updated by the deep-pattern auto-injected tools: `plan_create`, `plan_update_step`, `plan_get`. They live in the `plans` D1 table with a 30-day TTL.

---

## Jobs

A simple per-tenant registry of scheduled and on-demand agent invocations. The cron trigger (`*/10 * * * *`) sweeps the table and runs each due job under its owning tenant's identity.

### GET /jobs/list

```bash
curl -s -H "Authorization: Bearer $JWT" \
  $BASE_URL/jobs/list | jq
```

```json
{
  "jobs": [
    {
      "tenant_id": "acme",
      "name": "nightly-research",
      "schedule": "0 9 * * 1-5",
      "manifest_id": "research",
      "next_run_at": 1747119600000,
      "last_run_at": 1747033200000,
      "last_status": "scheduled",
      "last_error": "",
      "created_at": 1746000000000,
      "payload_json": "{ ... }"
    }
  ]
}
```

### GET /jobs/:name

Fetch one job by name. 404 if it isn't owned by the caller's tenant.

### POST /jobs

Upsert a job. The caller cannot impersonate another tenant — `tenant_id` is overwritten from the authenticated principal (`src/api/jobs.ts:39-44`).

**Body**

```json
{
  "name": "nightly-research",
  "schedule": "0 9 * * 1-5",
  "manifest_id": "research",
  "payload_json": "{\"messages\":[{\"role\":\"user\",\"content\":\"Daily roundup.\"}]}"
}
```

```bash
curl -s -X POST -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  $BASE_URL/jobs \
  -d '{"name":"nightly","schedule":"0 9 * * 1-5","manifest_id":"research"}' | jq
```

The server computes `next_run_at` from the schedule and persists the row. `schedule: ""` makes the job on-demand only (it will never be returned by the cron sweep). Schedules use the standard 5-field cron syntax — see [deploy.md](deploy.md) for the supported syntax.

### POST /jobs/run/:name

Manually trigger a job, recording it as an audit event with `status: manual`. The server updates `last_run_at`, `last_status: manual`, and recomputes `next_run_at`.

```bash
curl -s -X POST -H "Authorization: Bearer $JWT" \
  $BASE_URL/jobs/run/nightly-research | jq
```

```json
{ "ok": true }
```

## Manifests

Tenants manage their own manifests through an append-only, version-pinned store. Each write inserts a new version row and (by default) flips the active pointer; rollback is a pointer flip, not a content rewrite. The request-path resolver walks tenant D1 → tenant R2 → global R2 → bundled, so a tenant manifest with the same name as a bundled one (e.g. `shopping`) shadows the bundled copy for that tenant only.

Reads require the `manifests:read` scope; writes require `manifests:write`. All queries are tenant-scoped via the caller's JWT. In `ENVIRONMENT=development` without verifiers configured, the gate falls open so local probes and integration tests work without minting tokens.

Audit events: `manifest_created`, `manifest_activated`, `manifest_deleted`, `manifest_canary_set`, `manifest_canary_cleared`.

### GET /manifests

List the tenant's active manifests.

```bash
curl -s -H "Authorization: Bearer $JWT" \
  "$BASE_URL/manifests?limit=20" | jq
```

```json
{
  "manifests": [
    { "name": "shopping", "active_version": 3, "updated_at": 1747142400000 },
    { "name": "support",  "active_version": 1, "updated_at": 1747100000000 }
  ]
}
```

### GET /manifests/:name

Return the resolved manifest, with `source` (`tenant_d1` / `tenant_r2` / `global_r2` / `bundled`) and `version` (set only when `source` is `tenant_d1`). Supports `?version=N` to pin to a specific tenant version.

```bash
curl -s -H "Authorization: Bearer $JWT" \
  $BASE_URL/manifests/shopping | jq
```

```json
{
  "name": "shopping",
  "source": "tenant_d1",
  "version": 3,
  "manifest": { "apiVersion": "orchestrator/v1", "kind": "Agent", "metadata": { "name": "shopping", "version": "2.0.0", "description": "tenant-customized", "tags": [] }, "spec": { /* ... */ } }
}
```

### GET /manifests/:name/versions

List every tenant-private version row for `:name`, newest first, with an `active` flag.

```json
{
  "name": "shopping",
  "active_version": 3,
  "versions": [
    { "version": 3, "created_at": 1747142400000, "created_by": "user-123", "comment": "bump model", "active": true },
    { "version": 2, "created_at": 1747100000000, "created_by": "user-123", "comment": "",          "active": false },
    { "version": 1, "created_at": 1747000000000, "created_by": "user-456", "comment": "initial",  "active": false }
  ]
}
```

### GET /manifests/:name/versions/:version

Return a specific tenant version blob. 404 if the version does not exist for this tenant.

### POST /manifests/:name

Append a new version. The server validates the body with `ManifestSchema.parse(...)` plus `validateManifest(...)`, refuses if `metadata.name !== :name` (returns `400 name_mismatch`), then inserts the row and (by default) flips the active pointer atomically. Pass `?activate=false` to insert without activating.

```bash
curl -s -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  $BASE_URL/manifests/shopping \
  -d '{
    "manifest": {
      "apiVersion": "orchestrator/v1",
      "kind": "Agent",
      "metadata": { "name": "shopping", "version": "2.0.0", "description": "tenant-customized" },
      "spec": { "pattern": "react", "model": { "id": "@cf/meta/llama-3.1-8b-instruct" } }
    },
    "comment": "bump model"
  }' | jq
```

```json
{
  "name": "shopping",
  "version": 4,
  "created_at": 1747200000000,
  "created_by": "user-123",
  "comment": "bump model",
  "activated": true
}
```

Status codes: `201` on success, `400 bad_request` for malformed JSON / missing `manifest`, `400 validation_failed` for schema or cross-field violations, `400 name_mismatch` when URL and `metadata.name` disagree, `403 forbidden` when `manifests:write` is missing.

### POST /manifests/:name/activate

Flip the active pointer to a specific version. Used for rollback.

```bash
curl -s -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  $BASE_URL/manifests/shopping/activate \
  -d '{"version": 2}' | jq
```

```json
{ "name": "shopping", "active_version": 2, "updated_at": 1747250000000 }
```

`404 not_found` if the target version does not exist.

#### Eval activation gate (opt-in)

Two optional body fields make activation refuse to flip a version that has not passed an eval. **Both default to off** — a request with only `version` behaves exactly as before.

- `eval_run_id` — an `/eval` run id. Supplying it always enforces the gate: the run must be `completed`, have zero failing items, and its recorded `manifest_version` must equal the version being activated.
- `require_eval: true` — refuse the flip unless a passing `eval_run_id` is supplied (so an operator can force every activation through the gate even when no run id is passed).

```bash
# 1. Upload the candidate without activating it.
curl -s -X POST ".../manifests/shopping?activate=false" -d '{"manifest": …}'   # → version 3

# 2. Eval version 3 (pin it — the runner records the version on the run).
curl -s -X POST ".../eval/datasets/golden/run" \
  -d '{"candidate_manifest":"shopping","candidate_version":3}'   # → run_id

# 3. Activate 3, gated on that passing run.
curl -s -X POST ".../manifests/shopping/activate" \
  -d '{"version": 3, "require_eval": true, "eval_run_id": "<run_id>"}'
```

`409 eval_gate_failed` (with a `detail` string) when the referenced run is missing, tested a different manifest or version, is not `completed`, or has failing items — or when `require_eval` is set and no run id is supplied.

### POST /manifests/:name/canary

Set or update the canary pointer on the active manifest. The stable version is unchanged; the resolver hash-buckets each thread by `(tenant_id, thread_id, manifest_name, stable_v, canary_v)` so a single conversation stays on one side across the rollout. Flipping `canary_version` or `canary_weight` re-randomises bucket assignment.

Requires the `manifests:write` scope.

```bash
curl -s -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  $BASE_URL/manifests/shopping/canary \
  -d '{"canary_version": 3, "canary_weight": 25}' | jq
```

```json
{
  "name": "shopping",
  "active_version": 2,
  "canary_version": 3,
  "canary_weight": 25,
  "updated_at": 1747260000000
}
```

`canary_weight` is 0..100. Pass `canary_version: null` to clear the version pointer entirely (equivalent to `POST /rollback` with `clear_version: true`). The OpenAI-compatible surface (`/v1/chat/completions`, sync + stream) sets `x-manifest-variant: stable|canary` on every response that resolves through the tenant-D1 layer so an operator can verify the canary is reaching real traffic.

The same opt-in eval gate as `activate` applies: pass `eval_run_id` (and/or `require_eval: true`) to refuse pointing the canary at a version that has no passing run for it (`409 eval_gate_failed`). The gate is skipped when `canary_version` is `null` (clearing).

Emits `manifest_canary_set` audit.

### POST /manifests/:name/rollback

Atomically zero the canary weight (and optionally clear the canary version pointer too). Counterpart to the anomaly cron's auto-rollback path — both call into the same `clearCanary` primitive and emit `manifest_canary_cleared` audit events.

Requires the `manifests:write` scope.

```bash
curl -s -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  $BASE_URL/manifests/shopping/rollback \
  -d '{"clear_version": false}' | jq
```

```json
{
  "name": "shopping",
  "active_version": 2,
  "canary_version": 3,
  "canary_weight": 0,
  "updated_at": 1747270000000
}
```

`clear_version: false` (default) keeps the version pinned so a follow-up `POST /canary` can re-flip without re-supplying the version. `clear_version: true` resets `canary_version` to null.

### DELETE /manifests/:name

Drop every version row and the active pointer for `:name`. After this, the resolver falls through to tenant R2 / global R2 / bundled.

### DELETE /manifests/:name/versions/:version

Drop a single version row. Refuses with `409 conflict` if it is the currently-active version — activate another version first.

### Version pinning at request time

The OpenAI-compatible endpoint accepts an `x-manifest-version` header to pin a specific tenant version for one request. Useful for canary or diagnostic — production traffic continues to hit the active pointer.

```bash
curl -s -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "x-manifest-version: 2" \
  $BASE_URL/v1/chat/completions \
  -d '{"model":"shopping","messages":[{"role":"user","content":"hi"}]}'
```

---

## Eval

Golden-dataset evals backed by `eval_datasets` / `eval_dataset_items` / `eval_runs` D1 tables. Tenant-scoped; reads filter on `auth.principal.tenantId`. Reads require the `eval:read` scope; writes require `eval:write`.

### POST /eval/datasets

Create or upsert an eval dataset.

```bash
curl -s -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  $BASE_URL/eval/datasets \
  -d '{"name":"golden","description":"baseline regressions"}' | jq
```

### GET /eval/datasets

List datasets for the authenticated tenant.

### GET /eval/datasets/:name

Fetch a single dataset metadata row.

### POST /eval/datasets/:name/items

Add (or upsert by `item_id`) an item to a dataset.

```bash
curl -s -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  $BASE_URL/eval/datasets/golden/items \
  -d '{
    "item_id": "q1",
    "user_input": "What is the capital of France?",
    "rubric": {
      "criteria": "response identifies Paris",
      "must_include": ["paris"],
      "must_not_include": [],
      "pass_threshold": 0.7,
      "trajectory": {
        "max_tool_calls": 5,
        "forbidden_tools": ["memory_remember"],
        "required_tool_sequence": []
      }
    }
  }' | jq
```

The rubric layers — trajectory gates run first (deterministic, free), then substring gates (`must_include` / `must_not_include`), then the LLM judge against `criteria`. Each layer can short-circuit to fail.

### GET /eval/datasets/:name/items

List items in a dataset, ordered by creation time.

### POST /eval/datasets/:name/run

Execute the dataset against a candidate manifest. Synchronous; returns a summary. Per-item scores are persisted; fetch via `GET /eval/runs/:id`.

```bash
curl -s -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  $BASE_URL/eval/datasets/golden/run \
  -d '{"candidate_manifest":"research","deterministic_judge":false}' | jq
```

```json
{
  "run_id": "uuid",
  "pass_count": 23,
  "fail_count": 2,
  "pass_rate": 0.92
}
```

`deterministic_judge: true` uses substring + trajectory gates only — no `env.AI` calls. Useful for CI environments without an AI binding wired.

`candidate_version: N` pins the run to a specific tenant-managed manifest version instead of the active pointer — the only way to eval an inactive version before promoting it. The version the run tested is stored on the run row as `manifest_version` (null for bundled / R2 candidates) and is what the `/manifests` activate + canary eval gate matches against.

If the run throws before it finalizes (candidate not found, agent build error), the row is finalized `failed` rather than left `in_progress`.

### GET /eval/runs

List runs for the tenant, optionally filtered by `?dataset=…`.

### GET /eval/runs/:id

Fetch one run with per-item `ItemScore` rows: `{item_id, score, verdict, reasoning, response, tokens_input?, tokens_output?, tool_call_count?, duration_ms?}`. The cost dimensions enable the CI gate's `--cost-tolerance` check.

### `pnpm eval` — the CI gate

`scripts/eval.ts` is the merge-blocking gate. It POSTs to `/eval/datasets/:name/run`, then `GET /eval/runs/:id` for cost dimensions, and compares against a `--baseline` JSON file:

```bash
pnpm eval -- --base-url https://staging-make.felix.run \
  --dataset golden --candidate research \
  --baseline evals/baseline.json \
  --cost-tolerance 1.5 \
  --include-adversarial --adversarial-floor 0.95
```

Flags:

- `--min-pass-rate <f>` — default 0.8; floor when no baseline exists
- `--tolerance <f>` — default 0.05; slack against the baseline's pass_rate
- `--cost-tolerance <f>` — default 1.5; fail if `mean_tokens > baseline.mean_tokens × tolerance`. Set to 0 to disable
- `--deterministic` — uses substring + trajectory gates only (no `env.AI`)
- `--include-adversarial` — runs `<dataset>_adversarial` after the happy-path
- `--adversarial-floor <f>` — default 0.95; safety gate
- `--update-baseline` — on pass, write the new pass_rate + mean_tokens back to the baseline file

Exit codes: `0` clean pass, `1` regression (pass_rate or cost or adversarial), `2` argument error.

---

## Audit metrics

### GET /audit/metrics

Aggregated tool-call audit roll-up by `(manifest_id, tool, transport, status, error_code)` for a time window. Pairs with the Analytics Engine `orchestrator_tool_calls` dataset (longer retention) and the anomaly detector cron (which uses the same query shape).

```bash
curl -s -H "Authorization: Bearer $JWT" \
  "$BASE_URL/audit/metrics?since=$(( $(date +%s) - 3600 ))000&manifest_id=research" | jq
```

```json
{
  "since": 1747270000000,
  "until": 1747273600000,
  "rows": [
    {
      "manifest_id": "research",
      "tool": "memory_recall",
      "transport": "local",
      "status": "ok",
      "error_code": null,
      "count": 142,
      "avg_duration_ms": 3.2
    },
    {
      "manifest_id": "research",
      "tool": "notion__create_page",
      "transport": "mcp",
      "status": "error",
      "error_code": "provider_error",
      "count": 5,
      "avg_duration_ms": 1284.5
    }
  ]
}
```

Query params:

| Param | Type | Default | Notes |
|---|---|---|---|
| `since` | int (ms epoch) | 1 hour ago | Lower bound, inclusive |
| `until` | int (ms epoch) | now | Upper bound, inclusive |
| `manifest_id` | string | (all) | Filter rows to one manifest |
| `limit` | int | 100 | Max rows (1..500) |
