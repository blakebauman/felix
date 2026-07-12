/**
 * AI-discovery features against miniflare D1:
 *   - GEO monitoring store (queries + observations, cross-tenant cron read)
 *   - consent capture (append-only) + checkout attribution stamping
 */

import { env } from 'cloudflare:test';
import { writeCart } from '@felix/commerce/cart-session';
import {
  attributionSummary,
  getAttribution,
  latestConsentForThread,
  listConsents,
  recordConsent,
} from '@felix/commerce/consent/store';
import {
  listActiveQueries,
  listObservations,
  putObservation,
  upsertQuery,
} from '@felix/commerce/geo/store';
import { handleCheckoutCompleted } from '@felix/commerce/webhook';
import { getDb } from '@felix/harness/db/client';
import type { Env as AppEnv } from '@felix/harness/env';
import { describe, expect, it } from 'vitest';

const testEnv = env as unknown as AppEnv;

describe('geo monitoring store', () => {
  it('registers queries and reads active ones across tenants', async () => {
    await upsertQuery(testEnv, {
      tenant_id: 'geoA',
      id: 'q1',
      brand_id: 'acme',
      query_text: 'best running shoes',
      engine: 'workers_ai',
      active: true,
      created_at: 1,
    });
    await upsertQuery(testEnv, {
      tenant_id: 'geoB',
      id: 'q2',
      brand_id: 'beta',
      query_text: 'best espresso machine',
      engine: 'workers_ai',
      active: false,
      created_at: 2,
    });
    const active = await listActiveQueries(testEnv, 50);
    const ids = active.map((q) => q.id);
    expect(ids).toContain('q1');
    expect(ids).not.toContain('q2'); // inactive excluded
  });

  it('stores observations and lists them newest-first per query', async () => {
    await putObservation(testEnv, {
      tenant_id: 'geoA',
      id: 'o1',
      query_id: 'q1',
      brand_id: 'acme',
      engine: '@cf/meta/llama',
      ts: 100,
      brand_mentioned: true,
      rank: 3,
      competitors: ['Nike'],
      products: [],
      answer_excerpt: 'You might like Acme Trail...',
    });
    await putObservation(testEnv, {
      tenant_id: 'geoA',
      id: 'o2',
      query_id: 'q1',
      brand_id: 'acme',
      engine: '@cf/meta/llama',
      ts: 200,
      brand_mentioned: false,
      rank: 0,
      competitors: ['Nike', 'Adidas'],
      products: [],
      answer_excerpt: 'Top picks: Nike, Adidas...',
    });
    const obs = await listObservations(testEnv, 'geoA', { queryId: 'q1' });
    expect(obs.map((o) => o.id)).toEqual(['o2', 'o1']); // ts DESC
    expect(obs[0]?.brand_mentioned).toBe(false);
    expect(obs[1]?.rank).toBe(3);
    // tenant isolation
    expect(await listObservations(testEnv, 'geoB', { queryId: 'q1' })).toHaveLength(0);
  });
});

describe('consent capture', () => {
  it('is append-only; latest row for a thread wins', async () => {
    const thread = 'consentA:t1';
    await recordConsent(testEnv, {
      tenant_id: 'consentA',
      id: 'c1',
      subject: 'jane@acme.test',
      thread_id: thread,
      channel: 'chat',
      scopes: ['terms'],
      granted: true,
      terms_version: 'v1',
      policy_url: '',
      created_at: 10,
    });
    await recordConsent(testEnv, {
      tenant_id: 'consentA',
      id: 'c2',
      subject: 'jane@acme.test',
      thread_id: thread,
      channel: 'chat',
      scopes: ['terms'],
      granted: false, // withdrawal
      terms_version: 'v1',
      policy_url: '',
      created_at: 20,
    });
    const latest = await latestConsentForThread(testEnv, 'consentA', thread);
    expect(latest?.id).toBe('c2');
    expect(latest?.granted).toBe(false);
    expect(await listConsents(testEnv, 'consentA', { subject: 'jane@acme.test' })).toHaveLength(2);
  });
});

describe('checkout attribution', () => {
  it('stamps channel/consent attribution on the resulting order', async () => {
    const threadId = 'attrA:order-1';
    await writeCart(testEnv, threadId, {
      items: [{ product_id: 'x', title: 'X', qty: 1, price_cents: 1000 }],
      currency: 'usd',
      updated_at: 1,
    });
    await handleCheckoutCompleted(testEnv, {
      id: 'cs_attr_1',
      client_reference_id: threadId,
      amount_total: 1000,
      currency: 'usd',
      metadata: {
        tenant_id: 'attrA',
        thread_id: threadId,
        channel: 'chat',
        manifest_id: 'orderloop',
        buyer_subject: 'jane@acme.test',
        consent_id: 'c1',
      },
    });
    const orderRows = await getDb(testEnv)<{ id: string }[]>`
      SELECT id FROM orders WHERE tenant_id = 'attrA' AND stripe_ref = 'cs_attr_1'
    `;
    const orderRow = orderRows[0] ?? null;
    expect(orderRow).not.toBeNull();
    const attr = await getAttribution(testEnv, 'attrA', orderRow!.id);
    expect(attr?.channel).toBe('chat');
    expect(attr?.buyer_subject).toBe('jane@acme.test');
    expect(attr?.consent_id).toBe('c1');

    const summary = await attributionSummary(testEnv, 'attrA');
    expect(summary.find((s) => s.channel === 'chat')?.orders).toBe(1);
  });
});
