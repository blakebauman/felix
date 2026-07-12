/**
 * Consent + attribution store (Postgres). Tenant-scoped, composite keys.
 * Consent rows are append-only — `recordConsent` always inserts; the latest
 * row for a thread is authoritative.
 */

import { getDb } from '@felix/harness/db/client';
import type { Env } from '@felix/harness/env';
import {
  type Consent,
  type OrderAttribution,
  OrderAttribution as OrderAttributionSchema,
} from './models';

interface ConsentRow {
  tenant_id: string;
  id: string;
  subject: string;
  thread_id: string;
  channel: string;
  scopes_json: unknown;
  granted: boolean;
  terms_version: string;
  policy_url: string;
  created_at: number;
}

function safeArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asChannel(s: string): Consent['channel'] {
  return s === 'acp' || s === 'b2b' || s === 'widget' ? s : 'chat';
}

function rowToConsent(row: ConsentRow): Consent {
  return {
    tenant_id: row.tenant_id,
    id: row.id,
    subject: row.subject,
    thread_id: row.thread_id,
    channel: asChannel(row.channel),
    scopes: safeArray(row.scopes_json),
    granted: row.granted,
    terms_version: row.terms_version,
    policy_url: row.policy_url,
    created_at: row.created_at,
  };
}

export async function recordConsent(env: Env, consent: Consent): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO consents
        (tenant_id, id, subject, thread_id, channel, scopes_json, granted,
         terms_version, policy_url, created_at)
      VALUES (${consent.tenant_id}, ${consent.id}, ${consent.subject}, ${consent.thread_id},
              ${consent.channel}, ${consent.scopes as readonly unknown[]}, ${consent.granted},
              ${consent.terms_version}, ${consent.policy_url}, ${consent.created_at})
  `;
}

/** The most recent consent row for a thread, or null. */
export async function latestConsentForThread(
  env: Env,
  tenantId: string,
  threadId: string,
): Promise<Consent | null> {
  if (!threadId) return null;
  const sql = getDb(env);
  const rows = await sql<ConsentRow[]>`
    SELECT * FROM consents WHERE tenant_id = ${tenantId} AND thread_id = ${threadId}
      ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0] ? rowToConsent(rows[0]) : null;
}

export async function listConsents(
  env: Env,
  tenantId: string,
  opts: { subject?: string; limit?: number } = {},
): Promise<Consent[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const sql = getDb(env);
  const rows = await sql<ConsentRow[]>`
    SELECT * FROM consents
      WHERE tenant_id = ${tenantId}
      ${opts.subject ? sql`AND subject = ${opts.subject}` : sql``}
      ORDER BY created_at DESC LIMIT ${limit}
  `;
  return rows.map(rowToConsent);
}

interface AttributionRow {
  tenant_id: string;
  order_id: string;
  channel: string;
  manifest_id: string;
  thread_id: string;
  buyer_subject: string;
  consent_id: string;
  utm_json: unknown;
  created_at: number;
}

function safeUtm(v: unknown): Record<string, string> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
    return out;
  }
  return {};
}

export async function putAttribution(env: Env, attr: OrderAttribution): Promise<void> {
  const sql = getDb(env);
  await sql`
    INSERT INTO order_attribution
        (tenant_id, order_id, channel, manifest_id, thread_id, buyer_subject,
         consent_id, utm_json, created_at)
      VALUES (${attr.tenant_id}, ${attr.order_id}, ${attr.channel}, ${attr.manifest_id},
              ${attr.thread_id}, ${attr.buyer_subject}, ${attr.consent_id},
              ${attr.utm as Record<string, unknown>}, ${attr.created_at})
      ON CONFLICT (tenant_id, order_id) DO NOTHING
  `;
}

export async function getAttribution(
  env: Env,
  tenantId: string,
  orderId: string,
): Promise<OrderAttribution | null> {
  const sql = getDb(env);
  const rows = await sql<AttributionRow[]>`
    SELECT * FROM order_attribution WHERE tenant_id = ${tenantId} AND order_id = ${orderId} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return OrderAttributionSchema.parse({
    tenant_id: row.tenant_id,
    order_id: row.order_id,
    channel: row.channel,
    manifest_id: row.manifest_id,
    thread_id: row.thread_id,
    buyer_subject: row.buyer_subject,
    consent_id: row.consent_id,
    utm: safeUtm(row.utm_json),
    created_at: row.created_at,
  });
}

export interface AttributionSummaryRow {
  channel: string;
  manifest_id: string;
  orders: number;
}

/** Order counts grouped by channel + manifest — the agent-mediated-revenue view. */
export async function attributionSummary(
  env: Env,
  tenantId: string,
): Promise<AttributionSummaryRow[]> {
  const sql = getDb(env);
  const rows = await sql<{ channel: string; manifest_id: string; orders: number }[]>`
    SELECT channel, manifest_id, COUNT(*) AS orders
      FROM order_attribution WHERE tenant_id = ${tenantId}
      GROUP BY channel, manifest_id
      ORDER BY orders DESC
  `;
  return rows.map((r) => ({
    channel: r.channel,
    manifest_id: r.manifest_id,
    orders: Number(r.orders),
  }));
}
