/**
 * B2B accounts + buyers + purchase authority.
 *
 *   POST   /b2b/accounts                      → create account (native)
 *   GET    /b2b/accounts                       → list (through the seam)
 *   GET    /b2b/accounts/:id                   → get (through the seam)
 *   DELETE /b2b/accounts/:id                   → delete (native)
 *   POST   /b2b/accounts/:id/buyers            → add buyer (native)
 *   GET    /b2b/accounts/:id/buyers            → list buyers
 *   POST   /b2b/accounts/:id/purchase-check    → spending authority + approval routing
 *
 * Accounts/buyers are *read* through the entity data-source seam, so a tenant
 * can back them with a 3p ERP (federated/synced) without changing this router.
 * Writes are native (federated entities are managed in the source system).
 * Operator-scoped via `b2b:write`; reads need no scope (dev falls open).
 */

import type { AuthContext } from '@felix/orchestrator/auth/context';
import { requireScope } from '@felix/orchestrator/auth/middleware';
import type { Env } from '@felix/orchestrator/env';
import { Hono } from 'hono';
import { resolveEntitySource } from '../entities/resolver';
import {
  type Account,
  type Buyer,
  CreateAccountRequest,
  CreateBuyerRequest,
  PurchaseCheckRequest,
} from './models';
import { type ContractPrice, SetContractPriceRequest } from './pricing-models';
import { deleteContractPrice, listContractPrices, upsertContractPrice } from './pricing-store';
import { authorityCheck } from './service';
import { accountStore, buyerStore, deleteAccount, deleteBuyer, listBuyersByAccount } from './store';

const WRITE_SCOPE = 'b2b:write';
type Vars = { Variables: { auth: AuthContext } };

function tenantOf(c: { get: (k: 'auth') => AuthContext }): string {
  return c.get('auth').principal.tenantId;
}

export function buildB2bRouter(): Hono<{ Bindings: Env } & Vars> {
  const app = new Hono<{ Bindings: Env } & Vars>();

  app.post('/accounts', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const parsed = CreateAccountRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
    const tenant = tenantOf(c);
    if (await accountStore.get(c.env, tenant, parsed.data.id))
      return c.json({ error: 'account_exists' }, 409);
    const account: Account = {
      tenant_id: tenant,
      id: parsed.data.id,
      name: parsed.data.name,
      status: 'active',
      payment_terms: parsed.data.payment_terms ?? 'prepaid',
      credit_limit_cents: parsed.data.credit_limit_cents ?? 0,
      currency: parsed.data.currency ?? 'usd',
      metadata: parsed.data.metadata ?? {},
      created_at: Date.now(),
    };
    await accountStore.upsert(c.env, tenant, account);
    return c.json(account, 201);
  });

  app.get('/accounts', async (c) => {
    const source = await resolveEntitySource<Account>(c.env, tenantOf(c), 'account');
    const page = await source.list({ limit: 200 });
    return c.json({ accounts: page.items, source: source.mode }, 200);
  });

  app.get('/accounts/:id', async (c) => {
    const source = await resolveEntitySource<Account>(c.env, tenantOf(c), 'account');
    const account = await source.get(c.req.param('id'));
    if (!account) return c.json({ error: 'not_found' }, 404);
    return c.json(account, 200);
  });

  app.delete('/accounts/:id', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const ok = await deleteAccount(c.env, tenantOf(c), c.req.param('id'));
    return ok ? c.json({ ok: true }, 200) : c.json({ error: 'not_found' }, 404);
  });

  app.post('/accounts/:id/buyers', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const tenant = tenantOf(c);
    const accountId = c.req.param('id');
    if (!(await accountStore.get(c.env, tenant, accountId)))
      return c.json({ error: 'account_not_found' }, 404);
    const parsed = CreateBuyerRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
    const buyer: Buyer = {
      tenant_id: tenant,
      id: parsed.data.id,
      account_id: accountId,
      email: parsed.data.email ?? '',
      role: parsed.data.role ?? 'purchaser',
      spending_limit_cents: parsed.data.spending_limit_cents ?? 0,
      status: 'active',
      created_at: Date.now(),
    };
    await buyerStore.upsert(c.env, tenant, buyer);
    return c.json(buyer, 201);
  });

  app.get('/accounts/:id/buyers', async (c) => {
    return c.json(
      { buyers: await listBuyersByAccount(c.env, tenantOf(c), c.req.param('id')) },
      200,
    );
  });

  app.delete('/buyers/:id', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const ok = await deleteBuyer(c.env, tenantOf(c), c.req.param('id'));
    return ok ? c.json({ ok: true }, 200) : c.json({ error: 'not_found' }, 404);
  });

  // ---- account/contract pricing ----

  app.get('/accounts/:id/pricing', async (c) => {
    return c.json({ prices: await listContractPrices(c.env, tenantOf(c), c.req.param('id')) }, 200);
  });

  app.put('/accounts/:id/pricing/:product_id', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const tenant = tenantOf(c);
    const accountId = c.req.param('id');
    if (!(await accountStore.get(c.env, tenant, accountId)))
      return c.json({ error: 'account_not_found' }, 404);
    const parsed = SetContractPriceRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
    const now = Date.now();
    const contract: ContractPrice = {
      tenant_id: tenant,
      account_id: accountId,
      product_id: c.req.param('product_id'),
      currency: parsed.data.currency ?? 'usd',
      tiers: parsed.data.tiers,
      created_at: now,
      updated_at: now,
    };
    await upsertContractPrice(c.env, contract);
    return c.json(contract, 200);
  });

  app.delete('/accounts/:id/pricing/:product_id', async (c) => {
    const denied = requireScope(c, WRITE_SCOPE);
    if (denied) return denied;
    const ok = await deleteContractPrice(
      c.env,
      tenantOf(c),
      c.req.param('id'),
      c.req.param('product_id'),
    );
    return ok ? c.json({ ok: true }, 200) : c.json({ error: 'not_found' }, 404);
  });

  app.post('/accounts/:id/purchase-check', async (c) => {
    const parsed = PurchaseCheckRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
    const result = await authorityCheck(
      c.env,
      tenantOf(c),
      c.req.param('id'),
      parsed.data.buyer_id,
      parsed.data.amount_cents,
      parsed.data.note,
    );
    if (!result.ok)
      return c.json({ error: result.code }, result.code.endsWith('not_found') ? 404 : 400);
    const v = result.value;
    return c.json(
      {
        decision: v.decision,
        reason: v.reason,
        ...(v.approval_id
          ? { approval_id: v.approval_id, decide_at: `/approvals/${v.approval_id}/decide` }
          : {}),
      },
      200,
    );
  });

  return app;
}
