/**
 * Per-request context propagated via AsyncLocalStorage.
 *
 * A fresh RequestContext is attached for every inbound request inside the
 * Hono auth middleware; tool wrappers (limits/policy/approvals) read it
 * through `getContext()`.
 *
 * Why AsyncLocalStorage rather than threading a `ctx` parameter through
 * every tool call: tools are user-extensible, and we want to hide the
 * limit/policy state from tool authors so they can't accidentally tamper
 * with it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type postgres from 'postgres';
import { ANONYMOUS, type AuthContext } from './auth/context';
import type { Env } from './env';

export interface LimitState {
  toolCalls: number;
  peerHops: number;
  /** monotonic timestamp at request start (Date.now() suffices here). */
  startedAt: number;
  /** Number of audit events recorded under this request (capped). */
  auditCount: number;
  /** True once the one-shot `audit_truncated` marker has been emitted. */
  auditTruncatedEmitted: boolean;
  /** Count of audit events dropped after the truncation cap was reached. */
  droppedAfterTruncation: number;
  /**
   * Fires when a per-run limit is breached or the request ends. Tools see
   * it via `ToolInvocationCtx.signal`; the limits wrapper arms a timer
   * against it on first call when a wall-clock limit is configured.
   */
  abortController: AbortController;
  /** Handle for the wall-clock timer, cleared by `disposeLimitState`. */
  wallClockTimerId?: ReturnType<typeof setTimeout>;
  /** Cumulative model token spend for this request (sum across all turns). */
  tokens: { input: number; output: number };
}

export interface RequestContext {
  env: Env;
  /** Hono `ExecutionContext` for `waitUntil` / `passThroughOnException`. */
  execCtx?: ExecutionContext;
  auth: AuthContext;
  limitState: LimitState;
  /** Optional thread id for conversation checkpointing. */
  threadId?: string;
  /** Manifest currently being executed (used in audit + observability). */
  manifestId?: string;
  /**
   * Canary variant this request resolved to (`stable` / `canary`), set by
   * the route after `resolveManifest`. Stamped onto `tool_call` audit rows so
   * the anomaly detector can attribute error spikes to the right variant and
   * only roll back a canary that is itself failing.
   */
  manifestVariant?: 'stable' | 'canary';
  /**
   * True when this context drives a continuous-eval *replay* of sampled
   * production traffic (see `jobs/continuous-eval.ts`). The replay runs under
   * the canary's own tenant so tenant-A input never leaks into another
   * tenant's audit log, but its incidental `tool_call` rows must not be
   * re-sampled by a future tick — the react loop stamps `replay: true` onto
   * those rows and the sampler's WHERE clause excludes them.
   */
  replay?: boolean;
  /**
   * Per-request Postgres client, lazily created by `getDb` (db/client.ts) on
   * first use and reused by every store for the rest of the request. Never
   * closed explicitly — Hyperdrive owns connection lifecycle.
   */
  db?: postgres.Sql;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Strict accessor — throws if called outside a request scope. */
export function requireContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error('RequestContext not installed — call runWithContext from middleware first.');
  }
  return ctx;
}

export function newLimitState(): LimitState {
  return {
    toolCalls: 0,
    peerHops: 0,
    startedAt: Date.now(),
    auditCount: 0,
    auditTruncatedEmitted: false,
    droppedAfterTruncation: 0,
    abortController: new AbortController(),
    tokens: { input: 0, output: 0 },
  };
}

/**
 * Tear down per-request limit state. Always called in the auth middleware's
 * finally block so a hung tool can't outlive the request that started it
 * (the abort signal lets cooperating fetch / DO calls bail out).
 */
export function disposeLimitState(state: LimitState): void {
  if (state.wallClockTimerId !== undefined) {
    clearTimeout(state.wallClockTimerId);
    state.wallClockTimerId = undefined;
  }
  if (!state.abortController.signal.aborted) {
    state.abortController.abort(new DOMException('request ended', 'AbortError'));
  }
}

export function buildAnonymousContext(env: Env, execCtx?: ExecutionContext): RequestContext {
  return {
    env,
    execCtx,
    auth: ANONYMOUS,
    limitState: newLimitState(),
  };
}
