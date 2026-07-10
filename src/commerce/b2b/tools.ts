/**
 * B2B procurement agent tools. Thin wrappers over `service.ts` + the entity
 * seam so a (multi-)agent can run quote-to-cash: look up accounts/buyers,
 * build + send + accept + convert quotes, check spending authority, and read
 * invoices. Tenant comes from the RequestContext (like the other commerce
 * tools); registered in `composition.ts`.
 */

import { z } from 'zod';
import { getContext } from '../../context';
import { resolveEntitySource } from '../../entities/resolver';
import { defineTool, type Tool, type ToolOutput } from '../../tools/types';
import { getProduct } from '../catalog-store';
import { countRecentPurchases } from '../personalization/customer-store';
import type { Account, Buyer } from './models';
import { resolveEffectivePrice } from './pricing';
import type { Invoice, Quote } from './quote-models';
import {
  acceptQuote,
  authorityCheck,
  convertQuote,
  createQuote,
  payInvoice,
  type Result,
  sendQuote,
} from './service';

/** Demand window for velocity-based dynamic pricing. */
const DEMAND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function ctx(): { env: import('../../env').Env; tenant: string } | string {
  const rc = getContext();
  if (!rc) return '[b2b error] no request context';
  return { env: rc.env, tenant: rc.auth.principal.tenantId };
}

function out<T>(r: Result<T>): string {
  return r.ok
    ? JSON.stringify(r.value)
    : `[b2b error/${r.code}]${r.detail !== undefined ? ` ${JSON.stringify(r.detail)}` : ''}`;
}

const LineInput = z.object({
  product_id: z.string().min(1),
  qty: z.number().int().positive(),
  unit_price_cents: z.number().int().nonnegative().optional(),
  discount_cents: z.number().int().nonnegative().optional(),
});

export function accountGetTool(): Tool {
  return defineTool({
    name: 'account_get',
    description: 'Look up a B2B account by id (name, status, payment terms, credit limit).',
    args: z.object({ account_id: z.string().min(1) }).strict(),
    source: 'b2b',
    async handler({ account_id }): Promise<ToolOutput> {
      const c = ctx();
      if (typeof c === 'string') return c;
      const a = await (await resolveEntitySource<Account>(c.env, c.tenant, 'account')).get(
        account_id,
      );
      return a ? JSON.stringify(a) : `No account '${account_id}'.`;
    },
  });
}

export function buyerGetTool(): Tool {
  return defineTool({
    name: 'buyer_get',
    description: 'Look up a B2B buyer by id (account, role, spending limit, status).',
    args: z.object({ buyer_id: z.string().min(1) }).strict(),
    source: 'b2b',
    async handler({ buyer_id }): Promise<ToolOutput> {
      const c = ctx();
      if (typeof c === 'string') return c;
      const b = await (await resolveEntitySource<Buyer>(c.env, c.tenant, 'buyer')).get(buyer_id);
      return b ? JSON.stringify(b) : `No buyer '${buyer_id}'.`;
    },
  });
}

export function purchaseAuthorityTool(): Tool {
  return defineTool({
    name: 'purchase_authority_check',
    description:
      'Check whether a buyer may spend an amount for their account. Returns allowed / ' +
      'requires_approval (with an approval id to route) / blocked.',
    args: z
      .object({
        account_id: z.string().min(1),
        buyer_id: z.string().min(1),
        amount_cents: z.number().int().positive(),
        note: z.string().optional(),
      })
      .strict(),
    source: 'b2b',
    async handler({ account_id, buyer_id, amount_cents, note }): Promise<ToolOutput> {
      const c = ctx();
      if (typeof c === 'string') return c;
      return out(await authorityCheck(c.env, c.tenant, account_id, buyer_id, amount_cents, note));
    },
  });
}

export function priceLookupTool(): Tool {
  return defineTool({
    name: 'price_lookup',
    description:
      'Resolve the effective unit price for an account + product at a given quantity, ' +
      'applying contract volume tiers / account discount over the catalog price, then any ' +
      'active dynamic-pricing rules. Returns the unit_price_cents and the source ' +
      '(contract | account_discount | dynamic | catalog).',
    args: z
      .object({
        account_id: z.string().min(1),
        product_id: z.string().min(1),
        qty: z.number().int().positive().default(1),
      })
      .strict(),
    source: 'b2b',
    async handler({ account_id, product_id, qty }): Promise<ToolOutput> {
      const c = ctx();
      if (typeof c === 'string') return c;
      const product = await getProduct(c.env, c.tenant, product_id);
      if (!product) return `No product '${product_id}'.`;
      const nowMs = Date.now();
      const r = await resolveEffectivePrice(
        c.env,
        c.tenant,
        account_id,
        product_id,
        qty,
        product.price_cents,
        undefined,
        {
          category: product.category,
          signals: {
            nowMs,
            recentUnitsSold: await countRecentPurchases(
              c.env,
              c.tenant,
              product_id,
              nowMs - DEMAND_WINDOW_MS,
            ),
          },
        },
      );
      return JSON.stringify({
        product_id,
        qty,
        unit_price_cents: r.unit_price_cents,
        catalog_price_cents: product.price_cents,
        source: r.source,
      });
    },
  });
}

export function createQuoteTool(): Tool {
  return defineTool({
    name: 'create_quote',
    description:
      'Create a draft quote for an account + buyer from line items, priced from the catalog. ' +
      'Optionally override unit_price_cents / discount_cents per line for negotiated pricing.',
    args: z
      .object({
        account_id: z.string().min(1),
        buyer_id: z.string().min(1),
        items: z.array(LineInput).min(1),
        notes: z.string().optional(),
      })
      .strict(),
    source: 'b2b',
    async handler(args): Promise<ToolOutput> {
      const c = ctx();
      if (typeof c === 'string') return c;
      return out(await createQuote(c.env, c.tenant, args));
    },
  });
}

export function quoteGetTool(): Tool {
  return defineTool({
    name: 'quote_get',
    description: 'Get a quote by id, including its line items, totals, and status.',
    args: z.object({ quote_id: z.string().min(1) }).strict(),
    source: 'b2b',
    async handler({ quote_id }): Promise<ToolOutput> {
      const c = ctx();
      if (typeof c === 'string') return c;
      const q = await (await resolveEntitySource<Quote>(c.env, c.tenant, 'quote')).get(quote_id);
      return q ? JSON.stringify(q) : `No quote '${quote_id}'.`;
    },
  });
}

export function sendQuoteTool(): Tool {
  return defineTool({
    name: 'send_quote',
    description: 'Send a draft quote to the buyer, setting a validity window (default 14 days).',
    args: z
      .object({
        quote_id: z.string().min(1),
        valid_days: z.number().int().positive().max(365).optional(),
      })
      .strict(),
    source: 'b2b',
    async handler({ quote_id, valid_days }): Promise<ToolOutput> {
      const c = ctx();
      if (typeof c === 'string') return c;
      return out(await sendQuote(c.env, c.tenant, quote_id, valid_days ?? 14));
    },
  });
}

export function acceptQuoteTool(): Tool {
  return defineTool({
    name: 'accept_quote',
    description:
      'Accept a sent quote. Runs purchase authority: over the buyer limit, the quote moves to ' +
      'pending_approval and an approval is created (decide via /approvals).',
    args: z.object({ quote_id: z.string().min(1) }).strict(),
    source: 'b2b',
    async handler({ quote_id }): Promise<ToolOutput> {
      const c = ctx();
      if (typeof c === 'string') return c;
      return out(await acceptQuote(c.env, c.tenant, quote_id));
    },
  });
}

export function convertQuoteTool(): Tool {
  return defineTool({
    name: 'convert_quote',
    description:
      'Convert an accepted quote into an order + invoice (net terms). Requires the approval to ' +
      'be approved first if the quote is pending_approval.',
    args: z.object({ quote_id: z.string().min(1) }).strict(),
    source: 'b2b',
    async handler({ quote_id }): Promise<ToolOutput> {
      const c = ctx();
      if (typeof c === 'string') return c;
      return out(await convertQuote(c.env, c.tenant, quote_id));
    },
  });
}

export function invoiceGetTool(): Tool {
  return defineTool({
    name: 'invoice_get',
    description: 'Get an invoice by id (amount, terms, due date, status).',
    args: z.object({ invoice_id: z.string().min(1) }).strict(),
    source: 'b2b',
    async handler({ invoice_id }): Promise<ToolOutput> {
      const c = ctx();
      if (typeof c === 'string') return c;
      const inv = await (await resolveEntitySource<Invoice>(c.env, c.tenant, 'invoice')).get(
        invoice_id,
      );
      return inv ? JSON.stringify(inv) : `No invoice '${invoice_id}'.`;
    },
  });
}

export function payInvoiceTool(): Tool {
  return defineTool({
    name: 'pay_invoice',
    description: 'Mark an invoice as paid.',
    args: z.object({ invoice_id: z.string().min(1) }).strict(),
    source: 'b2b',
    async handler({ invoice_id }): Promise<ToolOutput> {
      const c = ctx();
      if (typeof c === 'string') return c;
      return out(await payInvoice(c.env, c.tenant, invoice_id));
    },
  });
}

/** All B2B procurement tool factories, registered together in composition.ts. */
export function b2bToolFactories(): Record<string, () => Tool> {
  return {
    account_get: accountGetTool,
    buyer_get: buyerGetTool,
    purchase_authority_check: purchaseAuthorityTool,
    price_lookup: priceLookupTool,
    create_quote: createQuoteTool,
    quote_get: quoteGetTool,
    send_quote: sendQuoteTool,
    accept_quote: acceptQuoteTool,
    convert_quote: convertQuoteTool,
    invoice_get: invoiceGetTool,
    pay_invoice: payInvoiceTool,
  };
}
