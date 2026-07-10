/**
 * B2B purchase authority decisions + the federated entity source (via a fake
 * connector, so the seam is proven without network).
 */

import { describe, expect, it } from 'vitest';
import { purchaseAuthority } from '../../src/commerce/b2b/authority';
import type { Account, Buyer } from '../../src/commerce/b2b/models';
import { mapAccount } from '../../src/commerce/b2b/store';
import { registerEntityConnector } from '../../src/entities/connectors';
import { federatedSource } from '../../src/entities/source';
import type { EntityConnector, EntityTypeSpec } from '../../src/entities/types';

function account(over: Partial<Account> = {}): Account {
  return {
    tenant_id: 't',
    id: 'acme',
    name: 'Acme',
    status: 'active',
    payment_terms: 'prepaid',
    credit_limit_cents: 0,
    currency: 'usd',
    metadata: {},
    created_at: 1,
    ...over,
  };
}
function buyer(over: Partial<Buyer> = {}): Buyer {
  return {
    tenant_id: 't',
    id: 'jane',
    account_id: 'acme',
    email: 'jane@acme.test',
    role: 'purchaser',
    spending_limit_cents: 10000,
    status: 'active',
    created_at: 1,
    ...over,
  };
}

describe('purchaseAuthority', () => {
  it('allows within the spending limit', () => {
    expect(purchaseAuthority(account(), buyer(), 5000).decision).toBe('allowed');
  });
  it('requires approval over the buyer limit', () => {
    expect(purchaseAuthority(account(), buyer(), 20000).decision).toBe('requires_approval');
  });
  it('admins bypass the per-buyer limit', () => {
    expect(purchaseAuthority(account(), buyer({ role: 'admin' }), 999999).decision).toBe('allowed');
  });
  it('blocks viewers, disabled buyers, and suspended accounts', () => {
    expect(purchaseAuthority(account(), buyer({ role: 'viewer' }), 1).decision).toBe('blocked');
    expect(purchaseAuthority(account(), buyer({ status: 'disabled' }), 1).decision).toBe('blocked');
    expect(purchaseAuthority(account({ status: 'suspended' }), buyer(), 1).decision).toBe(
      'blocked',
    );
  });
  it('blocks over the account credit limit on net terms', () => {
    const a = account({ payment_terms: 'net30', credit_limit_cents: 50000 });
    expect(purchaseAuthority(a, buyer({ role: 'admin' }), 60000).decision).toBe('blocked');
  });
  it('blocks a buyer from another account', () => {
    expect(purchaseAuthority(account(), buyer({ account_id: 'other' }), 1).decision).toBe(
      'blocked',
    );
  });
});

describe('federated entity source', () => {
  it('reads through a connector and maps raw records', async () => {
    registerEntityConnector('fake', () => {
      const conn: EntityConnector = {
        kind: 'fake',
        async fetchOne(_type, id) {
          return id === 'acme'
            ? { id: 'acme', name: 'Acme (ERP)', credit_limit: 99999, payment_terms: 'net30' }
            : null;
        },
        async fetchPage() {
          return { records: [{ id: 'acme', name: 'Acme (ERP)' }] };
        },
      };
      return conn;
    });

    const spec: EntityTypeSpec<Account> = {
      type: 'account',
      native: {} as never,
      mapper: mapAccount,
    };
    const env = {} as never;
    const src = federatedSource<Account>(env, 't', spec, { kind: 'fake', url: 'https://erp.test' });

    const one = await src.get('acme');
    expect(one?.name).toBe('Acme (ERP)');
    expect(one?.credit_limit_cents).toBe(99999);
    expect(one?.payment_terms).toBe('net30');
    expect(await src.get('missing')).toBeNull();

    const page = await src.list();
    expect(page.items[0]!.id).toBe('acme');
    expect(src.mode).toBe('federated');
  });
});
