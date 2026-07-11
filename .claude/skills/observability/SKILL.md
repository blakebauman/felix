---
name: observability
description: Where to look when Felix misbehaves — wrangler tail, the /audit surface, the audit event-type catalog, Analytics Engine counters, and the signal-to-cause map.
when_to_use: 'Requests like "check the logs", "tail production", "why did X fail in staging", "look at audit events", "what does checkpoint_failure mean", debugging live-environment behavior.'
---

# Observability

## Live logs

```bash
cd apps/api                      # bare wrangler commands need apps/api/wrangler.jsonc
wrangler tail --env staging      # or --env production
wrangler tail --env staging --search unhandled_exception
```
Structured shapes to grep for: `unhandled_exception` (carries stack; also lands as an `unhandled_error` audit event), `checkpoint_failure`, model-route errors. Observability sampling: 100% dev/staging, 10% production — absence of a log in prod is not absence of the event.

## Audit surface (needs `audit:read` token — see staging-auth skill)

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/audit?limit=20"
curl -H "Authorization: Bearer $TOKEN" "$BASE/audit/metrics"
```

Event-type catalog lives in `packages/harness/src/audit/models.ts`. Core: `tool_call` (status/error_code, `manifest_variant`, `user_input`), `policy_decision`, `limit_exceeded`, `guardrail_block`, `plan_step`, `job_run`, `approval_request/decision`, `checkpoint_failure`, `queue_dispatch/complete/expired`, `manifest_*`, `unhandled_error`, `judge_score` (`payload.source`: `reflect` | `continuous` | eval), `eval_run`, `anomaly_detected`, `auto_rollback`, `model_switch` (`reason`: `fallback` | `escalation`). Commerce: `commerce_order`, `brand_*`, `b2b_*`, `geo_observation`, `consent_recorded`, `order_attributed`, `cart_abandoned`.

## Metrics (Analytics Engine, dataset `felix_metrics`)

Written via `recordCounter`/`recordHistogram` (`packages/harness/src/observability/metrics.ts`): `index1` = manifest_id, `blob1` = metric name, `blob3+` = sorted `key=value` labels, `double1` = value. Key counters: `orchestrator_tool_calls{status,error_code}`, `orchestrator_tokens`, `orchestrator_model_switches`, `orchestrator_checkpoint_failures`, `orchestrator_audit_dropped`, `orchestrator_unhandled_error`. Dev fallback: structured stdout.

## Signal → cause map

| Signal | Meaning / next step |
|---|---|
| `checkpoint_failure` | ConversationDO write failed after 3 bounded retries — session events lost for that step; check DO health |
| `anomaly_detected` | Per-tool error rate exceeded the 24h EWMA baseline (thresholds from the manifest's `spec.anomaly`) |
| `auto_rollback` | The anomaly was on a canary variant — `canary_weight` was set to 0 automatically |
| `audit_truncated` status | Request hit the 200-event per-request audit cap — later events dropped (counted in `orchestrator_audit_dropped`) |
| `model_switch` reason=fallback | Primary model errored/rate-limited; chain replayed on a fallback id |
| `judge_score` source=continuous | Continuous-eval replay of production input through an in-flight canary |
| 404 unknown_manifest everywhere | Unapplied migrations on that env (see smoke-test skill) |

## Cron-context caveat

Cron and queue-consumer paths run outside `authMiddleware`; detached emitters use `recordEventDetached`. If an audit event you expected is missing from `/audit`, check whether the emitter had a RequestContext (no context → console.log fallback).
