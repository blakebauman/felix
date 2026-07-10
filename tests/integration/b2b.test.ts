/**
 * B2B accounts/buyers + the entity data-source seam, end-to-end against
 * miniflare D1. Covers native CRUD, purchase-authority + approval routing, a
 * webhook push into a synced entity, and a federated read via an in-test
 * connector registered on the seam.
 */

import { env, SELF } from 'cloudflare:test';
import type { Account } from '@felix/commerce/b2b/models';
import { setDataSourceConfig } from '@felix/commerce/entities/config-store';
import { registerEntityConnector } from '@felix/commerce/entities/connectors';
import { resolveEntitySource } from '@felix/commerce/entities/resolver';
import { beforeAll, describe, expect, it } from 'vitest';
import '@felix/commerce/b2b/store'; // registers 'account' / 'buyer' entity types
import type { Env as AppEnv } from '../../src/env';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;
const H = { 'content-type': 'application/json' };

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
});

async function createAccount(id: string, over: Record<string, unknown> = {}) {
  return SELF.fetch('https://o.test/b2b/accounts', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ id, name: `${id} Inc`, ...over }),
  });
}

describe('B2B accounts + buyers (native)', () => {
  it('creates accounts + buyers and lists them through the seam', async () => {
    expect((await createAccount('acme')).status).toBe(201);
    expect((await createAccount('acme')).status).toBe(409); // dup

    const buyer = await SELF.fetch('https://o.test/b2b/accounts/acme/buyers', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        id: 'jane@acme.test',
        role: 'purchaser',
        spending_limit_cents: 10000,
      }),
    });
    expect(buyer.status).toBe(201);

    const list = await SELF.fetch('https://o.test/b2b/accounts');
    const body = (await list.json()) as { accounts: Account[]; source: string };
    expect(body.source).toBe('native');
    expect(body.accounts.some((a) => a.id === 'acme')).toBe(true);
  });
});

describe('purchase authority + approval routing', () => {
  it('allows within limit, routes over-limit to an approval', async () => {
    await createAccount('routeco');
    await SELF.fetch('https://o.test/b2b/accounts/routeco/buyers', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ id: 'sam', spending_limit_cents: 5000 }),
    });

    const ok = await SELF.fetch('https://o.test/b2b/accounts/routeco/purchase-check', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ buyer_id: 'sam', amount_cents: 4000 }),
    });
    expect(((await ok.json()) as { decision: string }).decision).toBe('allowed');

    const over = await SELF.fetch('https://o.test/b2b/accounts/routeco/purchase-check', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ buyer_id: 'sam', amount_cents: 9000 }),
    });
    const body = (await over.json()) as { decision: string; approval_id?: string };
    expect(body.decision).toBe('requires_approval');
    expect(body.approval_id).toBeTruthy();

    // The routed approval is a real, decidable request in the approvals pipeline.
    const decide = await SELF.fetch(`https://o.test/approvals/${body.approval_id}/decide`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(decide.status).toBe(200);
  });
});

describe('entity data-source seam', () => {
  it('webhook push populates a synced entity in D1', async () => {
    await setDataSourceConfig(testEnv, 'syncco', 'account', { mode: 'synced' }, 'test');
    const push = await SELF.fetch('https://o.test/entities/account/push', {
      method: 'POST',
      headers: { ...H, 'x-consumer-secret': 'test-shared-secret' },
      body: JSON.stringify({
        tenant_id: 'syncco',
        records: [{ id: 'erp-1', name: 'From ERP', payment_terms: 'net30', credit_limit: 500000 }],
      }),
    });
    expect(((await push.json()) as { upserted: number }).upserted).toBe(1);

    const source = await resolveEntitySource<Account>(testEnv, 'syncco', 'account');
    const acct = await source.get('erp-1');
    expect(source.mode).toBe('synced');
    expect(acct?.name).toBe('From ERP');
    expect(acct?.credit_limit_cents).toBe(500000);
  });

  it('rejects a push without the shared secret', async () => {
    const r = await SELF.fetch('https://o.test/entities/account/push', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ tenant_id: 'x', records: [{ id: 'a', name: 'b' }] }),
    });
    expect(r.status).toBe(401);
  });

  it('federated mode reads through a connector (external source of truth)', async () => {
    registerEntityConnector('test-erp', () => ({
      kind: 'test-erp',
      async fetchOne(_t, id) {
        return id === 'remote-1' ? { id, name: 'Remote Co', credit_limit: 123456 } : null;
      },
      async fetchPage() {
        return { records: [{ id: 'remote-1', name: 'Remote Co' }] };
      },
    }));
    await setDataSourceConfig(
      testEnv,
      'fedco',
      'account',
      { mode: 'federated', connector: { kind: 'test-erp', url: 'https://erp.invalid' } },
      'test',
    );
    const source = await resolveEntitySource<Account>(testEnv, 'fedco', 'account');
    expect(source.mode).toBe('federated');
    const acct = await source.get('remote-1');
    expect(acct?.name).toBe('Remote Co');
    expect(acct?.credit_limit_cents).toBe(123456);
    // Not in our D1 — proves it came from the connector.
    const native = await testEnv.DB.prepare(
      'SELECT id FROM accounts WHERE tenant_id = ? AND id = ?',
    )
      .bind('fedco', 'remote-1')
      .first();
    expect(native).toBeNull();
  });
});
