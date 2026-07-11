/**
 * The B2B procurement agent tools drive quote-to-cash end-to-end (run under a
 * request context, since they read the tenant from it — exactly how the
 * procurement sub-agents invoke them). No LLM is involved.
 */

import { env } from 'cloudflare:test';
import { accountStore, buyerStore } from '@felix/commerce/b2b/store';
import {
  acceptQuoteTool,
  convertQuoteTool,
  createQuoteTool,
  purchaseAuthorityTool,
  sendQuoteTool,
} from '@felix/commerce/b2b/tools';
import { buildAnonymousContext, runWithContext } from '@felix/harness/context';
import { beforeAll, describe, expect, it } from 'vitest';
import '@felix/commerce/b2b/quote-store';
import { upsertProduct } from '@felix/commerce/catalog-store';
import type { Product } from '@felix/commerce/models';
import type { Env as AppEnv } from '@felix/harness/env';
import type { Tool } from '@felix/harness/tools/types';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;

async function run(tool: Tool, args: Record<string, unknown>): Promise<string> {
  return runWithContext(buildAnonymousContext(testEnv), async () => {
    const out = await tool.executor.execute(args, {});
    return typeof out === 'string' ? out : out.content;
  });
}

function product(id: string, price: number): Product {
  return {
    tenant_id: 'default',
    id,
    title: id,
    description: '',
    price_cents: price,
    currency: 'usd',
    image_url: '',
    category: '',
    inventory: 100,
    active: true,
    attrs: {},
    created_at: 1,
  };
}

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
  await upsertProduct(testEnv, product('bolt', 1000));
  await accountStore.upsert(testEnv, 'default', {
    tenant_id: 'default',
    id: 'pco',
    name: 'P Co',
    status: 'active',
    payment_terms: 'net30',
    credit_limit_cents: 100_000_000,
    currency: 'usd',
    metadata: {},
    created_at: 1,
  });
  await buyerStore.upsert(testEnv, 'default', {
    tenant_id: 'default',
    id: 'pbuyer',
    account_id: 'pco',
    email: '',
    role: 'purchaser',
    spending_limit_cents: 5000,
    status: 'active',
    created_at: 1,
  });
});

describe('procurement tools — quote-to-cash', () => {
  it('create → send → accept → convert within the buyer limit', async () => {
    const created = JSON.parse(
      await run(createQuoteTool(), {
        account_id: 'pco',
        buyer_id: 'pbuyer',
        items: [{ product_id: 'bolt', qty: 4 }], // $40 < $50 limit
      }),
    ) as { id: string; total_cents: number };
    expect(created.total_cents).toBe(4000);

    await run(sendQuoteTool(), { quote_id: created.id });
    const accepted = JSON.parse(await run(acceptQuoteTool(), { quote_id: created.id })) as {
      status: string;
    };
    expect(accepted.status).toBe('accepted');

    const converted = JSON.parse(await run(convertQuoteTool(), { quote_id: created.id })) as {
      order_id: string;
      invoice: { terms: string; amount_cents: number };
    };
    expect(converted.order_id).toBeTruthy();
    expect(converted.invoice.terms).toBe('net30');
    expect(converted.invoice.amount_cents).toBe(4000);
  });

  it('over-limit accept reports requires_approval (does not convert)', async () => {
    const created = JSON.parse(
      await run(createQuoteTool(), {
        account_id: 'pco',
        buyer_id: 'pbuyer',
        items: [{ product_id: 'bolt', qty: 9 }], // $90 > $50 limit
      }),
    ) as { id: string };
    await run(sendQuoteTool(), { quote_id: created.id });
    const accepted = JSON.parse(await run(acceptQuoteTool(), { quote_id: created.id })) as {
      status: string;
      approval_id: string;
    };
    expect(accepted.status).toBe('pending_approval');
    expect(accepted.approval_id).toBeTruthy();

    // convert is refused while pending.
    const convert = await run(convertQuoteTool(), { quote_id: created.id });
    expect(convert).toContain('[b2b error/not_ready]');
  });

  it('purchase_authority_check returns a structured decision', async () => {
    const ok = JSON.parse(
      await run(purchaseAuthorityTool(), {
        account_id: 'pco',
        buyer_id: 'pbuyer',
        amount_cents: 3000,
      }),
    ) as { decision: string };
    expect(ok.decision).toBe('allowed');
    const over = JSON.parse(
      await run(purchaseAuthorityTool(), {
        account_id: 'pco',
        buyer_id: 'pbuyer',
        amount_cents: 99999,
      }),
    ) as { decision: string; approval_id?: string };
    expect(over.decision).toBe('requires_approval');
    expect(over.approval_id).toBeTruthy();
  });
});
