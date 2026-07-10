/**
 * Predictive personalization: customer identity + behavior CRUD, the
 * abandoned-cart cron scan, and the recommend_products tool dispatch.
 *
 * Vectorize (MEMORY_VEC) isn't bound in the miniflare test pool, so similarity
 * queries degrade to empty — the tool is asserted to return a well-formed
 * (empty) array rather than throwing. The D1-backed behavior + abandonment
 * logic is exercised against the real test database.
 */

import { env } from 'cloudflare:test';
import { runAbandonedCartScan } from '@felix/commerce/personalization/abandoned-cart-job';
import {
  findAbandonedCandidates,
  getCustomer,
  getSessionCustomer,
  linkSessionToCustomer,
  listRecentBehavior,
  markAbandoned,
  recordBehaviorEvent,
  upsertCustomer,
} from '@felix/commerce/personalization/customer-store';
import { dispatchRecovery } from '@felix/commerce/personalization/recovery';
import { identifyCustomerTool, recommendProductsTool } from '@felix/commerce/personalization/tools';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildAnonymousContext, runWithContext } from '../../src/context';
import type { Env as AppEnv } from '../../src/env';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
});

describe('customer identity + behavior store', () => {
  it('upserts a customer, links a thread, and resolves it back', async () => {
    await upsertCustomer(testEnv, {
      tenant_id: 'p1',
      id: 'cust-1',
      email: 'a@b.test',
      external_ref: '',
      attrs: {},
      created_at: 1,
      last_seen_at: 1,
    });
    await linkSessionToCustomer(testEnv, 'p1', 'p1:thread-1', 'cust-1', 2);
    expect(await getSessionCustomer(testEnv, 'p1', 'p1:thread-1')).toBe('cust-1');
  });

  it('records and lists recent behavior filtered by type', async () => {
    await recordBehaviorEvent(testEnv, {
      tenant_id: 'p1',
      type: 'view',
      thread_id: 'p1:thread-1',
      product_id: 'sku-a',
      ts: 100,
    });
    await recordBehaviorEvent(testEnv, {
      tenant_id: 'p1',
      type: 'add_to_cart',
      thread_id: 'p1:thread-1',
      product_id: 'sku-b',
      ts: 200,
    });
    const events = await listRecentBehavior(testEnv, 'p1', {
      threadId: 'p1:thread-1',
      types: ['add_to_cart'],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.product_id).toBe('sku-b');
  });
});

describe('abandoned-cart detection', () => {
  it('flags an idle cart with intent but no purchase, exactly once', async () => {
    const now = 10_000_000;
    // Intent event well in the past (idle), no purchase.
    await recordBehaviorEvent(testEnv, {
      tenant_id: 'p2',
      type: 'add_to_cart',
      thread_id: 'p2:abandoned',
      product_id: 'sku-x',
      ts: now - 2 * 60 * 60 * 1000, // 2h ago → past the 1h idle threshold
    });
    // A converted thread should NOT be flagged.
    await recordBehaviorEvent(testEnv, {
      tenant_id: 'p2',
      type: 'add_to_cart',
      thread_id: 'p2:converted',
      product_id: 'sku-y',
      ts: now - 3 * 60 * 60 * 1000,
    });
    await recordBehaviorEvent(testEnv, {
      tenant_id: 'p2',
      type: 'purchase',
      thread_id: 'p2:converted',
      product_id: 'sku-y',
      ts: now - 2 * 60 * 60 * 1000,
    });

    const candidates = await findAbandonedCandidates(testEnv, {
      lookbackFrom: now - 7 * 24 * 60 * 60 * 1000,
      idleBefore: now - 60 * 60 * 1000,
      limit: 50,
    });
    const threads = candidates.map((c) => c.thread_id);
    expect(threads).toContain('p2:abandoned');
    expect(threads).not.toContain('p2:converted');

    const reqCtx = buildAnonymousContext(testEnv);
    const detected = await runWithContext(reqCtx, () => runAbandonedCartScan(testEnv, now));
    expect(detected).toBeGreaterThanOrEqual(1);

    // Second scan finds it already recorded → no new detection.
    const again = await runWithContext(reqCtx, () => runAbandonedCartScan(testEnv, now));
    expect(again).toBe(0);
  });

  it('markAbandoned is idempotent per thread', async () => {
    const c = { tenant_id: 'p3', thread_id: 'p3:t', customer_id: '', last_ts: 1 };
    expect(await markAbandoned(testEnv, c, 5)).toBe(true);
    expect(await markAbandoned(testEnv, c, 6)).toBe(false);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('identify_customer tool', () => {
  it('upserts a customer, links the thread, and backfills prior anonymous events', async () => {
    // Anonymous prior activity on the thread (tenant 'default').
    await recordBehaviorEvent(testEnv, {
      tenant_id: 'default',
      type: 'view',
      thread_id: 'default:id-1',
      product_id: 'sku-z',
      ts: 100,
    });
    const out = await runWithContext(buildAnonymousContext(testEnv), () =>
      identifyCustomerTool().executor.execute(
        { email: 'Me@Test.com', name: 'Mira' },
        { threadId: 'default:id-1' },
      ),
    );
    expect(typeof out === 'string' ? out : out.content).toContain('me@test.com');

    expect(await getSessionCustomer(testEnv, 'default', 'default:id-1')).toBe('me@test.com');
    const cust = await getCustomer(testEnv, 'default', 'me@test.com');
    expect(cust?.email).toBe('me@test.com');
    // Prior anonymous event now attributed to the customer.
    const events = await listRecentBehavior(testEnv, 'default', { customerId: 'me@test.com' });
    expect(events.some((e) => e.product_id === 'sku-z')).toBe(true);
  });
});

describe('abandoned-cart recovery dispatch', () => {
  it('no-ops when no recovery webhook is configured', async () => {
    const ok = await dispatchRecovery({} as AppEnv, {
      tenant_id: 't',
      thread_id: 't:1',
      customer_id: '',
      email: '',
      idle_ms: 1,
      detected_at: 1,
    });
    expect(ok).toBe(false);
  });

  it('POSTs the recovery payload to the configured webhook', async () => {
    let capturedBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = String(init?.body ?? '');
        return new Response('ok', { status: 200 });
      }),
    );
    const ok = await dispatchRecovery(
      { COMMERCE_RECOVERY_WEBHOOK: 'https://hook.test' } as AppEnv,
      {
        tenant_id: 't',
        thread_id: 't:1',
        customer_id: 'c',
        email: 'c@test.com',
        idle_ms: 3_600_000,
        detected_at: 5,
      },
    );
    expect(ok).toBe(true);
    const body = JSON.parse(capturedBody);
    expect(body.type).toBe('abandoned_cart');
    expect(body.email).toBe('c@test.com');
  });
});

describe('recommend_products tool', () => {
  it('returns an empty array (no embeddings bound) without throwing', async () => {
    const tool = recommendProductsTool();
    const reqCtx = buildAnonymousContext(testEnv);
    const raw = await runWithContext(reqCtx, () =>
      tool.executor.execute({ product_id: 'sku-a' }, { threadId: 'p1:thread-1' }),
    );
    const out = typeof raw === 'string' ? raw : raw.content;
    expect(Array.isArray(JSON.parse(out))).toBe(true);
  });
});
