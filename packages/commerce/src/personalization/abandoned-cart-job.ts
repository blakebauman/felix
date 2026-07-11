/**
 * Abandoned-cart cron. Each tick scans `behavior_events` (globally, like the
 * anomaly detector) for threads that showed purchase intent — an `add_to_cart`
 * or `checkout_start` — but never completed a `purchase`, and have been idle
 * past `IDLE_MS` within the lookback window. Each newly-detected cart is recorded
 * in `abandoned_carts` (dedup state) and emits a `cart_abandoned` audit event.
 *
 * Notification delivery is intentionally a seam: the audit event is the signal a
 * brand operator (or a follow-up job) acts on — wiring email/SMS recovery comes
 * later via the email service. Stateless + time-windowed, so it is safe to run
 * every tick without coordinating state across ticks.
 *
 * Runs under the anonymous cron RequestContext installed in `index.ts:scheduled`,
 * so `recordEvent` enqueues audit rows normally.
 */

import { recordEvent } from '@felix/harness/audit/store';
import type { Env } from '@felix/harness/env';
import { recordCounter } from '@felix/harness/observability/metrics';
import {
  type AbandonedCandidate,
  findAbandonedCandidates,
  getCustomer,
  markAbandoned,
} from './customer-store';
import { dispatchRecovery } from './recovery';

const IDLE_MS = 60 * 60 * 1000; // 1h since last activity → considered abandoned
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // only scan the last week of events
const MAX_PER_TICK = 200;

export async function runAbandonedCartScan(env: Env, nowMs: number = Date.now()): Promise<number> {
  let detected = 0;
  let candidates: AbandonedCandidate[] = [];
  try {
    candidates = await findAbandonedCandidates(env, {
      lookbackFrom: nowMs - LOOKBACK_MS,
      idleBefore: nowMs - IDLE_MS,
      limit: MAX_PER_TICK,
    });
  } catch (err) {
    console.error('abandoned-cart scan query failed', err);
    return 0;
  }

  for (const candidate of candidates) {
    try {
      const isNew = await markAbandoned(env, candidate, nowMs);
      if (!isNew) continue;
      detected += 1;
      // Resolve the shopper's email (if they identified) for recovery delivery.
      const email = candidate.customer_id
        ? ((await getCustomer(env, candidate.tenant_id, candidate.customer_id))?.email ?? '')
        : '';
      const idleMs = nowMs - candidate.last_ts;
      recordEvent({
        tenantId: candidate.tenant_id,
        eventType: 'cart_abandoned',
        principalSubject: candidate.customer_id,
        status: 'alert',
        payload: {
          thread_id: candidate.thread_id,
          customer_id: candidate.customer_id,
          email,
          last_activity_at: candidate.last_ts,
          idle_ms: idleMs,
        },
      });
      // Outbound recovery (email/SMS via the brand's webhook). No-op when unset.
      await dispatchRecovery(env, {
        tenant_id: candidate.tenant_id,
        thread_id: candidate.thread_id,
        customer_id: candidate.customer_id,
        email,
        idle_ms: idleMs,
        detected_at: nowMs,
      });
    } catch (err) {
      console.error('abandoned-cart mark failed', err);
    }
  }

  if (detected > 0) {
    recordCounter('orchestrator_abandoned_carts_detected', {}, detected);
  }
  return detected;
}
