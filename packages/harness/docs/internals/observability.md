---
description: "Counter labels, audit event payload shapes, and alert thresholds for Felix operators."
---

# Observability — counters, audit events, alerts

This is the operator's reference for what Felix emits, what it means, and what to alert on. It complements [governance.md](governance.md) (which covers *why* a wrapper fires) by focusing on the *signals* the wrapper leaves behind.

:::tip[Counters first, audit log second]
**Counters are the signal you alert on.** Audit events are the trail you read once an alert fires. Set up Analytics Engine dashboards over the counter reference below; drop into `/audit` to pivot on the specific tool or tenant after a threshold trips.
:::

## Where signals land

Felix has two emission paths:

- **Counters / histograms** — `recordCounter(name, labels, value)` / `recordHistogram(name, value, labels)` in [`src/observability/metrics.ts`](../../src/observability/metrics.ts). In dev/tests these log structured JSON lines so `wrangler tail` shows them; in production they fan out via `env.METRICS.writeDataPoint({ blobs: [...labels], doubles: [value] })` to Workers Analytics Engine (dataset declared in `wrangler.jsonc` as `analytics_engine_datasets`). When the binding is absent the stdout fallback continues to fire so dev parity holds.
- **Spans** — `withSpan(name, fn, attrs)` and `manifestSpan(name, version)` in [`src/observability/tracing.ts`](../../src/observability/tracing.ts). Spans wrap each tool dispatch and the outer `buildAgent`/`invoke` boundary, attaching `duration_ms`, `transport`, `manifest_id`, `status`, and on error `error_code`. Spans are kept in-process today (the export sink is a no-op); pair them with `wrangler tail` to see the structured span lines.
- **Audit events** — `recordEvent(AuditEvent)` in [`src/audit/store.ts`](../../src/audit/store.ts) writes to the `AUDIT_QUEUE` queue. The queue consumer batches up to 50 events per pull and inserts into D1 (`audit_events` table, composite PK `(tenant_id, id)`). Failed batch inserts fall back to per-row inserts so one poison row doesn't starve the queue.

Counters are the signal you alert on. Audit events are the trail you read once an alert fires.

## Counter reference

| Counter | Labels | Emitted by | Meaning |
|---|---|---|---|
| `orchestrator_tool_calls` | `manifest_id`, `transport`, `status`, `error_code?` | [`patterns/react.ts`](../../src/patterns/react.ts) | One per tool dispatch. `transport ∈ {local, mcp, a2a, container, queue, sandbox, browser, unknown}`. `status ∈ {ok, error}`. On `error`, `error_code` is one of `ToolErrorCode`. |
| `orchestrator_tokens` | `manifest_id`, `model`, `kind` | [`patterns/model.ts`](../../src/patterns/model.ts) | Token usage per model call. `kind ∈ {input, output, cache_creation, cache_read}`. |
| `orchestrator_policy_decisions` | `outcome`, `policy_id`, `manifest_id`, `transport` | [`policy/wrap.ts`](../../src/policy/wrap.ts) | Only `outcome: 'denied'` is emitted — allows are quiet. The `transport` label is the inner tool's transport (preserved through the wrapper). |
| `orchestrator_limit_breaches` | `limit`, `manifest_id`, `transport?` | [`limits/wrap.ts`](../../src/limits/wrap.ts) | `limit ∈ {max_tool_calls, max_peer_hops, max_wall_clock_seconds, max_input_tokens, max_output_tokens}`. `transport` is attached only when known. |
| `orchestrator_guardrail_blocks` | `surface`, `manifest_id`, `transport` | [`guardrails/wrap.ts`](../../src/guardrails/wrap.ts) | Emitted on every guardrail evaluation (matched or clean). `surface ∈ {input, output}`. |
| `orchestrator_judge_scores` | `judge`, `tool`, `verdict`, `manifest_id` | [`guardrails/judge-wrap.ts`](../../src/guardrails/judge-wrap.ts) | One per completed LLM-judge invocation. `verdict ∈ {pass, fail}`. Disambiguate `reflect` verifier vs `guardrails.judges[]` rubric judges by `payload.source` on the paired `judge_score` audit. |
| `orchestrator_judge_skipped` | `reason`, `judge`, `manifest_id` | [`guardrails/judge-wrap.ts`](../../src/guardrails/judge-wrap.ts) | A judge was configured but couldn't run (e.g. `reason: 'no_ai_binding'`). |
| `orchestrator_judge_error` | `judge`, `manifest_id` | [`guardrails/judge-wrap.ts`](../../src/guardrails/judge-wrap.ts) | A judge invocation threw. |
| `orchestrator_plan_steps` | `manifest_id`, `status` | [`patterns/plan-execute.ts`](../../src/patterns/plan-execute.ts) | One per `plan_execute` step. `status ∈ {ok, error, replanned}`. Pair with the `plan_step` audit row to see the step id and tool-call set. |
| `orchestrator_approval_requests` | `manifest_id`, `transport` | [`approvals/wrap.ts`](../../src/approvals/wrap.ts) | One per pending-approval branch. |
| `orchestrator_approval_decisions` | `outcome`, `manifest_id`, `transport` | [`approvals/wrap.ts`](../../src/approvals/wrap.ts) | `outcome ∈ {approved, denied}`. Expirations don't emit here — they show up only as audit events. |
| `orchestrator_checkpoint_failures` | `manifest_id` | [`session/do-session.ts`](../../src/session/do-session.ts) | Terminal failure after 3 retries to persist a session event batch to `ConversationDO`. **Should be zero.** |
| `orchestrator_anomalies` | `manifest_id`, `tool`, `error_code` | [`jobs/anomaly-detector.ts`](../../src/jobs/anomaly-detector.ts) | One per per-tool error-rate anomaly flagged against the 24h EWMA baseline during a cron sweep. |
| `orchestrator_auto_rollbacks` | `manifest_id` | [`jobs/anomaly-detector.ts`](../../src/jobs/anomaly-detector.ts) | A flagged anomaly belonged to a canary; its `canary_weight` was set to 0. |
| `orchestrator_durable_started` | `manifest_id` | [`manifests/builder.ts`](../../src/manifests/builder.ts) | A `DurableAgent` kicked off an `AGENT_WORKFLOW` run. |
| `orchestrator_durable_complete` | `manifest_id`, `status` | [`manifests/builder.ts`](../../src/manifests/builder.ts) | A durable workflow run finished. `status` is `complete` or the terminal workflow status. |
| `orchestrator_durable_fallback` | `manifest_id` | [`manifests/builder.ts`](../../src/manifests/builder.ts) | `execution.mode: durable` declared but `env.AGENT_WORKFLOW` binding absent. Fell back to transient. **Should be zero in prod.** |
| `orchestrator_model_switches` | `from`, `to`, `reason` | [`patterns/model.ts`](../../src/patterns/model.ts) | Fallback chain or confidence-routed escalation fired. `reason ∈ {provider_error, low_confidence}` — `provider_error` for fallback-chain switches, `low_confidence` for confidence-escalation switches. |
| `orchestrator_unhandled_error` | `path`, `method`, `tenant_id` | [`src/app.ts`](../../src/app.ts) | The Hono `onError` boundary caught a non-`HTTPException`. **Should be zero.** |
| `orchestrator_audit_dropped` | `manifest_id`, `event_type` | [`audit/store.ts`](../../src/audit/store.ts) | Events dropped after the per-request audit cap (200) was hit. Pairs with the `audit_truncated` status marker. |
| `orchestrator_audit_dlq_received` | (none; value = events drained) | [`jobs/audit-dlq.ts`](../../src/jobs/audit-dlq.ts) | Audit events dead-lettered off `felix-audit-<env>` after exhausting retries, drained by the `-dlq` branch of the `queue()` handler (best-effort re-persisted to D1). **Non-zero means the main audit consumer is failing** — investigate D1 health. |
| `orchestrator_retention_deleted` | `table` | [`jobs/retention.ts`](../../src/jobs/retention.ts) | Rows/objects pruned by the `retention_sweep` cron. `table ∈ {audit_events, plans, artifacts}`. |
| `orchestrator_conversation_idle_expired` | (none) | [`memory/conversation-do.ts`](../../src/memory/conversation-do.ts) | A `ConversationDO` thread's storage was wiped by its idle-TTL alarm after `CONVERSATION_IDLE_TTL_DAYS` of inactivity. |
| `orchestrator_artifact_spill_failed` | `manifest_id` | [`tools/artifacts.ts`](../../src/tools/artifacts.ts) | An R2 artifact spill failed; the tool result was returned inline instead of as a stub. |
| `orchestrator_semantic_retrieval_failed` | `manifest_id` | [`session/semantic-strategy.ts`](../../src/session/semantic-strategy.ts) | The `semantic:N` strategy's BGE retrieval errored and degraded to a fallback render. |
| `orchestrator_rate_limit_binding_error` | — | [`security/rate-limit.ts`](../../src/security/rate-limit.ts) | The `TENANT_RATE_LIMIT` binding threw; the request was allowed through (fail-open). |
| `orchestrator_abandoned_carts_detected` | (none; value = carts detected) | [`jobs/abandoned-cart.ts`](../../src/jobs/abandoned-cart.ts) | Carts flagged by the abandoned-cart cron. See [the commerce docs](../../../commerce/docs/index.md). |
| `orchestrator_geo_mention` / `orchestrator_geo_rank` | `manifest_id` (brand), `engine`, `mentioned` (mention only) | [`jobs/geo-monitor.ts`](../../src/jobs/geo-monitor.ts) | GEO monitor: brand-mention counter + rank histogram per tracked query replay. |
| `orchestrator_continuous_eval` | `manifest_id`, `verdict` | [`jobs/continuous-eval.ts`](../../src/jobs/continuous-eval.ts) | Judged canary replays from the continuous-eval cron. |

### The `transport` label

Every governance counter carries the inner tool's `transport`. This is the load-bearing observability claim from the executor refactor: a tool wrapped in `applyPolicies(applyLimits(applyGuardrails(applyJudges(applyApprovals(tool)))))` still reports `transport: 'mcp'` (or `a2a` / `container` / `local` / `queue` / `sandbox` / `browser`) on every counter — the wrapper composition preserves it through `wrapExecutor(inner.executor, ...)`.

:::note[`transport: 'unknown'` is a signal]
If you see `transport: 'unknown'` on `orchestrator_tool_calls`, the model called a name that isn't in the tool registry — a typo in tool arguments, a hallucinated tool name, or a stale manifest cached from a previous deploy.
:::

The labels in this table are the **emitted** set — they're what you'll see on the wire. The tool name itself isn't a counter label (cardinality concerns); it lives on every `audit_event` row via `payload.tool` instead. Filter counters by `transport` + `manifest_id` to scope a query; drop into the audit log to pivot on the specific tool.

## Audit event reference

Audit events are persisted to D1 and queryable through `GET /audit?tenant=…&event_type=…`. Every event carries `id`, `tenant_id`, `ts`, `event_type`, `manifest_id`, `principal_subject`, `status`, and a `payload` JSON blob. The shape:

| `event_type` | Emitted by | `status` values | Key `payload` fields |
|---|---|---|---|
| `tool_call` | react/deep loop | `ok`, `error` | `tool`, `transport`, `args`, then `output_preview` (success) or `error`+`error_code` (failure). Unknown-tool dispatch records as `transport: 'unknown'`. For `transport: 'queue'`, the `tool_call` row only records the *enqueue* — the eventual `tool_result` pairs to a `queue_complete` row. |
| `policy_decision` | policy wrapper | `denied` (allows are quiet) | `policy_id`, `tool`, `transport`, `missing_scopes` |
| `limit_exceeded` | limits wrapper | `denied` | `tool`, `limit`, `cap`, `observed`, `transport` (when known) |
| `guardrail_block` | guardrails wrapper | `matched`, `clean` | `tool`, `transport`, `surface`, `matches` |
| `judge_score` | judge wrapper / reflect pattern | `pass`, `fail` | Judge wrapper: `judge` (judge name), `tool`, `transport`, `score`, `threshold`, `reasoning`. Reflect pattern: `source: 'reflect'`, `score`, plus its critique fields. Reflect rows carry `payload.source`; judge-wrapper rows don't, which is how you tell them apart. |
| `plan_step` | plan tools / `plan_execute` pattern | step status (`pending`, `in_progress`, `done`, `ok`, `error`, `replanned`) | For plan tools: `plan_id`, `step_id`, `result_present`. For `plan_execute`: `source: 'plan_execute'`, `plan_id`, `step_id` (subtask id / `plan` / `replan_N` / `synthesis`), `executor_model`, `tool_calls`, `tool_call_count`, `duration_ms`, plus `subtask_count` / `rationale` / `replans_used` depending on step. |
| `approval_request` | approvals wrapper | `pending` | `approval_id`, `tool`, `transport` |
| `approval_decision` | approvals wrapper / `/approvals/:id/decide` | `approved`, `denied` | `approval_id`, `tool`, `transport` |
| `checkpoint_failure` | `persistFireAndForget` | `failed` | `thread_id`, `event_count`, `error` |
| `queue_dispatch` | `QueueExecutor` | `enqueued` | `job_id`, `tool`, `tool_call_id`, `thread_id`, `deadline_ms?` |
| `queue_complete` | queue consumer (external) | `ok`, `error` | `job_id`, `tool_call_id`, `duration_ms?` |
| `queue_expired` | orphan-cleanup cron | `expired` | `job_id`, `tool_call_id`, `thread_id`, `age_ms` |
| `job_run` | scheduled-job runner | `ok`, `error` | `name`, `duration_ms` |
| `manifest_created` / `manifest_activated` / `manifest_deleted` | `/manifests` REST | varies | `manifest_id`, `version` |
| `manifest_canary_set` / `manifest_canary_cleared` | `/manifests/:name/canary` | `ok` | `manifest_id`, `stable_version`, `canary_version`, `canary_weight` |
| `auto_rollback` | `jobs/anomaly-detector.ts` | `ok` | `manifest_id`, `canary_version`, `error_rate`, `baseline`, `breakdown` |
| `anomaly_detected` | `jobs/anomaly-detector.ts` | `flagged` | `manifest_id`, `tool`, `error_code`, `rate`, `baseline`, `window_minutes` |
| `model_switch` | `patterns/model.ts` | `fallback`, `escalated` | `from`, `to`, `reason ∈ {provider_error, low_confidence}`. Status `fallback` + reason `provider_error` = fallback chain switch. Status `escalated` + reason `low_confidence` = confidence-escalation switch. |
| `eval_run` | (reserved) | — | Defined in the `AuditEventType` enum but not yet emitted; eval runs currently record their per-item verdicts as `judge_score` events (`src/eval/runner.ts`). |
| `unhandled_error` | `src/app.ts` `app.onError` | `error` | `path`, `method`, `error_message`, `stack_preview` |
| `commerce_order` | Stripe webhook on `checkout.session.completed` / ACP completion | `paid` | `order_id`, `tenant_id`, `thread_id`, `amount_cents`, `channel`, `manifest_id`. Emitted after inventory decrement, cart clear, and attribution write. |
| `brand_provisioned` | `POST /brands` | `ok` | `brand_id`, `name`, `domain`. |
| `brand_catalog_import` | `POST /brands/:id/catalog` | `ok`, `error` | `brand_id`, `product_count`, `error?`. |
| `b2b_purchase_check` | `purchase_authority_check` tool / `POST /b2b/accounts/:id/purchase-check` | `allowed`, `requires_approval`, `blocked` | `account_id`, `buyer_id`, `amount_cents`, `reason`. |
| `b2b_quote` | quote lifecycle tools (`create_quote`, `send_quote`, `accept_quote`, `convert_quote`) | `draft`, `sent`, `accepted`, `ordered` | `quote_id`, `account_id`, `amount_cents`. |
| `geo_observation` | GEO monitor cron per tracked query replay | `ok` | `brand_id`, `query`, `engine`, `mentioned`, `rank?`, `competitors[]`. |
| `consent_recorded` | `commerce_record_consent` tool / `POST /commerce/consents` | `granted`, `withdrawn` | `thread_id`, `channel`, `terms_version`, `privacy_url`. |
| `order_attributed` | Stripe webhook / ACP completion | `ok` | `order_id`, `thread_id`, `channel`, `manifest_id`, `buyer_subject`. |
| `cart_abandoned` | abandoned-cart cron | `detected` | `tenant_id`, `thread_id`, `customer_id?`, `email?`, `recovery_webhook_sent`. |

### `status: 'audit_truncated'`

`audit_truncated` is **not** an event type. It's a `status` value applied to whatever event triggered the per-request audit cap (200 events, `PER_REQUEST_AUDIT_CAP` in `src/audit/store.ts`), with payload `{ reason: 'per_request_cap', cap: 200 }`. Read it as "the event below this point in the request was dropped to protect the queue." The drop also increments `orchestrator_audit_dropped`.

## Alerts worth wiring up

These are the signals where a non-zero rate over a 5–10 minute window is a real problem:

| Alert | Query (Workers Analytics / log search) | Threshold | Why |
|---|---|---|---|
| **Checkpoint divergence** | `count(metric=orchestrator_checkpoint_failures)` | `> 0` | A persistent failure means the model history and the session log have diverged. Subsequent turns will hydrate against incomplete events. |
| **Unknown tool dispatch** | `count(metric=orchestrator_tool_calls labels.transport=unknown labels.status=error)` | `> 0` | The model called a name the registry doesn't know. Likely a manifest drift or a hallucinated tool name. |
| **Policy denies on a previously-quiet manifest** | `rate(metric=orchestrator_policy_decisions labels.outcome=denied labels.manifest_id=X)` | spike over baseline | A federation bundle revocation just landed, or a tenant's manifest started referencing a tool it doesn't have scopes for. |
| **Limit breaches** | `rate(metric=orchestrator_limit_breaches labels.limit=max_wall_clock_seconds)` | spike over baseline | Wall-clock breaches are the canary for upstream model latency or runaway tool loops. |
| **Approval starvation** | `count(audit event_type=approval_request) - count(audit event_type=approval_decision) where ts < now() - 1h` | `> 0` | Pending approvals older than an hour usually mean nobody is watching the queue. |
| **Queue dispatch starvation** | `count(audit event_type=queue_dispatch) - count(audit event_type=queue_complete) - count(audit event_type=queue_expired) where ts < now() - 30m` | `> 0` | Async tools are being dispatched but their consumer never lands a result. Either the consumer Worker is broken or the queue producer is misconfigured. |

## What an incident walk looks like

A typical "something is wrong with manifest X" investigation:

1. **Filter audit by manifest and tenant** — `GET /audit?tenant=acme&manifest_id=research&limit=100` returns the recent timeline. Each row's `event_type` + `status` shows where the loop bailed.
2. **Find the failing `tool_call`** — `payload.tool` + `payload.transport` identifies which executor returned non-ok. If `transport: 'mcp'` or `a2a`, the failure is remote; check the peer's audit next.
3. **Cross-reference with `orchestrator_tool_calls{manifest_id=…}` counter** — confirm whether this is a one-off (single error) or a pattern (rising error rate).
4. **For checkpoint failures** — `payload.error` carries the exception string from the DO write. `payload.thread_id` lets you read the events that *did* land (`GET /events?thread_id=…` via the conversation DO) to see how far the session got before divergence.

## Local development

Counters print to stdout as one JSON line per emission, so `pnpm dev` + a separate `wrangler tail` (or the Wrangler UI) is enough to see everything end-to-end. The line shape:

```json
{"metric":"orchestrator_tool_calls","kind":"counter","value":1,"labels":{"manifest_id":"quick","transport":"local","status":"ok"}}
```

Audit events in dev fall back to `console.log` when no `RequestContext` is installed (cron edge cases) — they appear as structured `audit_event` lines on the same tail.

## Session strategy leverage

For sizing decisions on long conversations, here's what each `spec.session.strategy` value produces on a 50-event synthetic fixture (`tests/unit/session/strategies_benchmark.test.ts`):

| Strategy | Messages sent to model | Content bytes | vs full_replay |
|---|---|---|---|
| `full_replay` | 52 | 5671 | 100% |
| `windowed:5` | 7 | 576 | 10.2% |
| `summarizing:5` | 8 | 683 | 12.0% |
| `semantic:5` | 8 | ~620 | ~11% |

`summarizing:N` makes **one** model call when new events first cross the keep boundary; subsequent renders with no new boundary-crossing events do zero model calls (the summary is cached as a `kind: 'audit'` event with `metadata.covers_to_seq`).

`semantic:N` uses BGE embeddings on the current user message to retrieve the top-N most relevant prior events from the session log instead of the most recent N. Anchor messages (`metadata.pinned === true`) are always included regardless of the score. Use for long-running threads where stale near-tail events out-rank older but topical events.

## See also

- [`docs/internals/governance.md`](governance.md) — the wrappers that emit most of the counters above
- [`docs/internals/persistence.md`](persistence.md) — the session log schema (relevant for checkpoint failures)
- [`docs/guide/management-api.md`](../guide/management-api.md) — `/audit` query parameters and response shape
