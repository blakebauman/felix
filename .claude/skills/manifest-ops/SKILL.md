---
name: manifest-ops
description: Runtime manifest lifecycle for Felix without redeploying — 4-layer resolution, /manifests REST versioning, canary weights, rollback, and the eval gate.
when_to_use: 'Requests like "canary this manifest", "rollback the manifest", "update a manifest without deploying", "run the eval gate", "which manifest version is live", per-tenant manifest overrides.'
---

# Manifest ops

## Resolution (who wins)

`resolveManifest(env, tenantId, name)` walks: **tenant Postgres → tenant R2 (`manifests/<tenant>/<name>.json`) → global R2 (`manifests/<name>.json`) → bundled** (audit `source` strings keep the legacy `tenant_d1` name). The chain runs for every tenant including `default`. Bundled = code-reviewed defaults shipped with the Worker (`packages/harness/manifests/*.yaml` → `pnpm build:manifests` → deploy); Postgres/R2 = runtime overrides, no deploy needed.

## REST lifecycle (`/manifests`, scopes `manifests:read` / `manifests:write` — token via staging-auth skill)

- Versions are **append-only**; an active-pointer row (`manifest_active`) selects the live version.
- `POST /manifests` new version → activate → instant; **rollback** = `POST /manifests/:name/rollback` (moves the active pointer back — much faster than redeploying).
- **Canary**: `POST /manifests/:name/canary` sets `canary_version` + `canary_weight`. Routing is deterministic per thread: SHA-256 hash of `(tenant_id, thread_id, manifest_name, stable_version, canary_version)`.

## What watches a canary automatically

- **Anomaly detector** (10-min cron): per-tool error rates vs 24h EWMA; if the spike is on the canary variant (tool_call rows carry `manifest_variant`), it emits `auto_rollback` and sets `canary_weight = 0`. Thresholds tunable per manifest via `spec.anomaly`.
- **Continuous eval**: replays recent production inputs through the canary version, scores with the Workers-AI judge, emits `judge_score` with `payload.source: 'continuous'`. Knobs via the `CONTINUOUS_EVAL` env JSON.

Watch both through `/audit` (observability skill).

## Eval gate (spends model tokens — confirm before running against production)

```bash
EVAL_TOKEN=$(pnpm tsx apps/api/scripts/mint-jwt.ts --scope "eval:read eval:write" | jq -r .token) \
  pnpm eval -- --base-url $BASE --dataset <dataset> \
  [--min-pass-rate 0.9] [--cost-tolerance 1.5] [--include-adversarial]
```
Enforces a pass-rate floor (baseline − tolerance or explicit `--min-pass-rate`), a token-cost gate, and optionally the adversarial floor (0.95). Use before widening a canary or promoting it to active.

### Server-side activation gate (opt-in)

Beyond the CLI gate, `POST /manifests/:name/activate` and `/canary` accept `eval_run_id` (and/or `require_eval: true`). When supplied, the server refuses the version flip (`409 eval_gate_failed`) unless that `/eval` run is `completed`, has zero failures, and tested this exact `(manifest, version)`. Both fields default off — omitting them keeps activation ungated. To produce a matching run, pin the version at run time: `POST /eval/datasets/:name/run` with `candidate_version: N` (the runner records it as `manifest_version` on the run). A run that throws before finishing is finalized `failed`, never left `in_progress`.

## Bundled-manifest changes (the deploy path)

Edit `packages/harness/manifests/<name>.yaml` → `pnpm build:manifests` → tests → deploy. Remember tenant Postgres/R2 overrides still shadow the new bundled version for tenants that have them.
