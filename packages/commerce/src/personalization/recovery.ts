/**
 * Abandoned-cart recovery delivery seam. The abandoned-cart cron detects idle
 * carts and emits an audit event; this is the outbound delivery hook that turns
 * that signal into a shopper-facing nudge (email / SMS / push).
 *
 * Delivery is intentionally provider-agnostic and inert until configured: when
 * `COMMERCE_RECOVERY_WEBHOOK` is set, the recovery payload (including the
 * customer's email when known) is POSTed there, and the brand wires that webhook
 * to its email service / ESP. With no webhook configured this is a no-op, so the
 * cron degrades to "audit only" rather than failing.
 */

import type { Env } from '@felix/orchestrator/env';
import { assertSafeOutboundUrlForEnv } from '@felix/orchestrator/security/ssrf';

export interface RecoveryPayload {
  tenant_id: string;
  thread_id: string;
  customer_id: string;
  email: string;
  idle_ms: number;
  detected_at: number;
}

/** POST the recovery payload to the configured webhook. Returns true on 2xx. */
export async function dispatchRecovery(env: Env, payload: RecoveryPayload): Promise<boolean> {
  const url = env.COMMERCE_RECOVERY_WEBHOOK;
  if (!url) return false;
  try {
    // Operator-configured webhook, but route it through the SSRF guard for
    // consistency so a misconfigured URL can't POST buyer PII to an internal host.
    assertSafeOutboundUrlForEnv(url, env);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'abandoned_cart', ...payload }),
    });
    return res.ok;
  } catch (err) {
    console.warn('dispatchRecovery failed', err);
    return false;
  }
}
