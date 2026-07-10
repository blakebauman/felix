/**
 * Limit-state accessor that wraps the per-request AsyncLocalStorage.
 * No explicit install step — the auth middleware always populates the
 * context before any tool wrapper runs.
 */

import { getContext, type LimitState } from '../context';

export function currentLimitState(): LimitState | undefined {
  return getContext()?.limitState;
}

export function currentTenantSubject(): { tenantId: string; subject: string } {
  const ctx = getContext();
  if (!ctx) return { tenantId: 'default', subject: '' };
  return { tenantId: ctx.auth.principal.tenantId, subject: ctx.auth.principal.subject };
}

/**
 * The per-request abort signal — fires when a wall-clock limit elapses or
 * the request is torn down. Patterns should pass this into model.chat /
 * model.streamChat so a long-running model call cancels mid-flight.
 */
export function currentSignal(): AbortSignal | undefined {
  return getContext()?.limitState?.abortController.signal;
}
