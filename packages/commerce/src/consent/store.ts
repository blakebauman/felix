/**
 * Consent + attribution store (D1). Tenant-scoped, composite keys. Consent
 * rows are append-only — `recordConsent` always inserts; the latest row for a
 * thread is authoritative.
 */

import type { Env } from '@felix/orchestrator/env';
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
  scopes_json: string;
  granted: number;
  terms_version: string;
  policy_url: string;
  created_at: number;
}

function safeArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
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
    granted: row.granted === 1,
    terms_version: row.terms_version,
    policy_url: row.policy_url,
    created_at: row.created_at,
  };
}

export async function recordConsent(env: Env, consent: Consent): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO consents
        (tenant_id, id, subject, thread_id, channel, scopes_json, granted,
         terms_version, policy_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      consent.tenant_id,
      consent.id,
      consent.subject,
      consent.thread_id,
      consent.channel,
      JSON.stringify(consent.scopes),
      consent.granted ? 1 : 0,
      consent.terms_version,
      consent.policy_url,
      consent.created_at,
    )
    .run();
}

/** The most recent consent row for a thread, or null. */
export async function latestConsentForThread(
  env: Env,
  tenantId: string,
  threadId: string,
): Promise<Consent | null> {
  if (!threadId) return null;
  const row = await env.DB.prepare(
    `SELECT * FROM consents WHERE tenant_id = ? AND thread_id = ?
       ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(tenantId, threadId)
    .first<ConsentRow>();
  return row ? rowToConsent(row) : null;
}

export async function listConsents(
  env: Env,
  tenantId: string,
  opts: { subject?: string; limit?: number } = {},
): Promise<Consent[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const stmt = opts.subject
    ? env.DB.prepare(
        `SELECT * FROM consents WHERE tenant_id = ? AND subject = ?
           ORDER BY created_at DESC LIMIT ?`,
      ).bind(tenantId, opts.subject, limit)
    : env.DB.prepare(
        `SELECT * FROM consents WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
      ).bind(tenantId, limit);
  const rows = await stmt.all<ConsentRow>();
  return (rows.results ?? []).map(rowToConsent);
}

interface AttributionRow {
  tenant_id: string;
  order_id: string;
  channel: string;
  manifest_id: string;
  thread_id: string;
  buyer_subject: string;
  consent_id: string;
  utm_json: string;
  created_at: number;
}

function safeUtm(s: string): Record<string, string> {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object') {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
      return out;
    }
  } catch {
    /* fall through */
  }
  return {};
}

export async function putAttribution(env: Env, attr: OrderAttribution): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO order_attribution
        (tenant_id, order_id, channel, manifest_id, thread_id, buyer_subject,
         consent_id, utm_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, order_id) DO NOTHING`,
  )
    .bind(
      attr.tenant_id,
      attr.order_id,
      attr.channel,
      attr.manifest_id,
      attr.thread_id,
      attr.buyer_subject,
      attr.consent_id,
      JSON.stringify(attr.utm),
      attr.created_at,
    )
    .run();
}

export async function getAttribution(
  env: Env,
  tenantId: string,
  orderId: string,
): Promise<OrderAttribution | null> {
  const row = await env.DB.prepare(
    'SELECT * FROM order_attribution WHERE tenant_id = ? AND order_id = ? LIMIT 1',
  )
    .bind(tenantId, orderId)
    .first<AttributionRow>();
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
  const rows = await env.DB.prepare(
    `SELECT channel, manifest_id, COUNT(*) AS orders
       FROM order_attribution WHERE tenant_id = ?
       GROUP BY channel, manifest_id
       ORDER BY orders DESC`,
  )
    .bind(tenantId)
    .all<{ channel: string; manifest_id: string; orders: number }>();
  return (rows.results ?? []).map((r) => ({
    channel: r.channel,
    manifest_id: r.manifest_id,
    orders: r.orders,
  }));
}
