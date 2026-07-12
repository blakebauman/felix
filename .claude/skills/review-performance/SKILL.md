---
name: review-performance
description: Performance review of Felix changes with a Cloudflare Workers lens — waitUntil offloading, Postgres batching and index coverage, parallel awaits, cancellation, caching, DO access patterns.
when_to_use: 'Requests like "performance review", "is this slow", "optimize this", "review for latency", or changes touching the request path, Postgres queries, model calls, or Durable Object access.'
---

# Review: performance (Workers runtime lens)

## Target

Default: current diff (`git diff` + `git diff --cached`, or `git diff main...HEAD`). Delegate large diffs to the **felix-reviewer** subagent with this checklist as the lens.

## Checklist

- **Off the critical path**: fire-and-forget work (audit writes, session persistence, metrics) goes through `execCtx.waitUntil` — pattern: `persistFireAndForget` in `packages/harness/src/session/do-session.ts`. Flag new awaited writes that block the LLM/request loop.
- **Postgres**: no N+1 query loops — use multi-row inserts (`${sql(rows)}`; the audit consumer is the exemplar) or `sql.begin` transactions; new query shapes have index coverage (`(tenant_id, ts DESC)` for time-ordered, `(tenant_id, <filter>)` otherwise); no `SELECT *` on wide tables in hot paths; per-request client reuse comes free via getDb's context cache.
- **Parallelism**: independent awaits use `Promise.all`. EXCEPTION — do NOT "fix" the react loop's sequential tool dispatch: it is deliberate for deterministic audit ordering.
- **Cancellation**: `ctx.signal` threaded into fetches and `ModelChatOptions.signal` into model calls — without it a wall-clock breach only blocks the *next* call, so in-flight work burns CPU-ms against the 60s cap.
- **Token spend**: model-calling loops check `checkTokenBudget` (or the Anthropic preflight `checkPreflightTokenBudget`) before each call; large tool results respect the artifact spill threshold instead of ballooning the context.
- **Caching**: hot reads use KV (`CACHE`) — manifest cache, JWKS cache, OAuth token cache; per-isolate memoization only for request-agnostic values (`compose(env)` is the precedent — keep anything cached at module level request-agnostic).
- **Durable Objects**: avoid chatty many-small-call patterns against `ConversationDO` — use the ranged `GET /events?from&to&limit&kinds` params; don't add all-or-nothing history dumps back.
- **Bundle/audit volume**: per-request audit cap is 200 events — new code emitting per-iteration events in tight loops will hit `audit_truncated`; aggregate instead.

## Verify claims

For any "this is faster" assertion, point at the mechanism (fewer round-trips, index hit, off-path write) — don't accept vibes. Benchmark precedent: `packages/harness/tests/unit/session/strategies_benchmark.test.ts`.

## Output

Severity-ranked findings with `file:line`, each naming the cost (added latency, CPU-ms, Postgres round-trips, token spend) and the fix. State "no findings" per category you cleared.
