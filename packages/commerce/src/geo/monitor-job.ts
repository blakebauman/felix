/**
 * GEO / AEO monitoring tick.
 *
 * Each cron tick this job answers "how does this brand show up when an AI does
 * the shopping?" — the blind spot the Forbes/Finger piece names as mistake #1.
 * For every active `geo_query` (capped per tick to bound AI spend) it:
 *
 *   1. replays the shopping-style prompt through a generative engine (Workers AI
 *      in v1 — same isolate, no AI Gateway tokens, like the eval judge),
 *   2. extracts — with a second structured Workers-AI call — whether the brand
 *      is mentioned, at what 1-based rank, which competitors co-occur, and which
 *      of the brand's own products are cited,
 *   3. writes a `geo_observations` row and emits a `geo_observation` audit event
 *      + `orchestrator_geo_rank` histogram so the trend is visible in `/audit`
 *      and Analytics Engine.
 *
 * Stateless: the work list is the `geo_queries` table; there is no cursor. The
 * per-tick cap is a hard ceiling on engine calls — anything beyond it is logged,
 * never silently dropped.
 */

import { recordEventDetached } from '@felix/orchestrator/audit/store';
import type { Env } from '@felix/orchestrator/env';
import { recordCounter, recordHistogram } from '@felix/orchestrator/observability/metrics';
import { getBrand } from '../brands/store';
import { listProductsPage } from '../catalog-store';
import type { GeoObservation, GeoQuery } from './models';
import { listActiveQueries, putObservation } from './store';

export interface GeoMonitorOpts {
  /** Hard cap on queries processed per tick — bounds Workers-AI spend. */
  max_queries_per_tick: number;
  /** Generative model used to answer the tracked query. */
  gen_model: string;
  /** Model used to extract the structured signal from the answer. */
  extract_model: string;
}

export const DEFAULT_GEO_MONITOR_OPTS: GeoMonitorOpts = {
  max_queries_per_tick: 20,
  gen_model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  extract_model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
};

const MAX_QUERIES_CEILING = 200;

/**
 * Resolve per-tick knobs from the optional `GEO_MONITOR` env var (JSON). Each
 * field is validated and clamped independently; anything missing or malformed
 * falls back to defaults rather than disabling the job or blowing the budget.
 */
export function parseGeoMonitorOpts(env: Env): GeoMonitorOpts {
  const d = DEFAULT_GEO_MONITOR_OPTS;
  if (!env.GEO_MONITOR) return d;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(env.GEO_MONITOR) as Record<string, unknown>;
  } catch {
    return d;
  }
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const cap = num(raw.max_queries_per_tick);
  return {
    max_queries_per_tick:
      cap !== null
        ? Math.max(0, Math.min(MAX_QUERIES_CEILING, Math.floor(cap)))
        : d.max_queries_per_tick,
    gen_model: str(raw.gen_model) ?? d.gen_model,
    extract_model: str(raw.extract_model) ?? d.extract_model,
  };
}

export interface GeoExtraction {
  mentioned: boolean;
  rank: number;
  competitors: string[];
  products: string[];
}

const EMPTY_EXTRACTION: GeoExtraction = {
  mentioned: false,
  rank: 0,
  competitors: [],
  products: [],
};

/**
 * Parse the extractor model's JSON reply into a `GeoExtraction`. Pure +
 * defensive — a malformed reply degrades to "not mentioned" rather than
 * throwing, so one bad answer never fails the tick. Exported for unit tests.
 */
export function parseExtraction(raw: string): GeoExtraction {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return EMPTY_EXTRACTION;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return EMPTY_EXTRACTION;
  }
  const mentioned = obj.mentioned === true;
  const rankRaw = typeof obj.rank === 'number' ? obj.rank : Number(obj.rank);
  const rank = Number.isFinite(rankRaw) && rankRaw > 0 ? Math.floor(rankRaw) : 0;
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];
  return {
    mentioned: mentioned || rank > 0,
    rank: mentioned ? rank : rank > 0 ? rank : 0,
    competitors: strArray(obj.competitors),
    products: strArray(obj.products),
  };
}

const EXTRACT_SYSTEM_PROMPT =
  'You analyze an AI shopping answer for brand visibility. Reply with ONLY a JSON object on ' +
  'one line: {"mentioned": <bool>, "rank": <int, 1-based position of the brand in the answer, ' +
  '0 if absent>, "competitors": [<other brand names mentioned>], "products": [<the brand\'s own ' +
  'products named>]}. No prose, no markdown.';

function buildExtractPrompt(brandName: string, productTitles: string[], answer: string): string {
  return [
    `Brand to find: ${brandName}`,
    productTitles.length ? `Brand's products: ${productTitles.join(', ')}` : '',
    `AI answer:\n${answer}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function askEngine(env: Env, model: string, query: string): Promise<string> {
  const reply = (await env.AI.run(model, {
    messages: [
      {
        role: 'system',
        content:
          'You are a helpful shopping assistant. Recommend specific brands and products for ' +
          "the shopper's request, as you would to a real customer.",
      },
      { role: 'user', content: query },
    ],
    max_tokens: 600,
    temperature: 0.7,
  })) as { response?: string };
  return reply.response ?? '';
}

async function extractSignal(
  env: Env,
  model: string,
  brandName: string,
  productTitles: string[],
  answer: string,
): Promise<GeoExtraction> {
  if (!answer) return EMPTY_EXTRACTION;
  const reply = (await env.AI.run(model, {
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: buildExtractPrompt(brandName, productTitles, answer) },
    ],
    max_tokens: 300,
    temperature: 0,
  })) as { response?: string };
  return parseExtraction(reply.response ?? '');
}

export interface GeoMonitorResult {
  processed: number;
  mentioned: number;
  dropped: number;
}

/** Resolve a display name + product titles for a query's brand context. */
async function brandContext(
  env: Env,
  q: GeoQuery,
): Promise<{ name: string; productTenant: string; titles: string[] }> {
  let name = q.brand_id || q.tenant_id;
  let productTenant = q.tenant_id;
  if (q.brand_id) {
    const brand = await getBrand(env, q.tenant_id, q.brand_id);
    if (brand) {
      name = brand.name;
      productTenant = brand.brand_tenant;
    }
  }
  const { products } = await listProductsPage(env, productTenant, { limit: 30, offset: 0 });
  return { name, productTenant, titles: products.map((p) => p.title) };
}

export async function runGeoMonitorTick(
  env: Env,
  opts: GeoMonitorOpts = DEFAULT_GEO_MONITOR_OPTS,
  now: number = Date.now(),
  execCtx?: ExecutionContext,
): Promise<GeoMonitorResult> {
  const result: GeoMonitorResult = { processed: 0, mentioned: 0, dropped: 0 };
  if (!env.DB || !env.AI || opts.max_queries_per_tick <= 0) return result;

  // Pull one extra to detect (and report) work shed by the per-tick cap.
  const queries = await listActiveQueries(env, opts.max_queries_per_tick + 1);
  const batch = queries.slice(0, opts.max_queries_per_tick);
  result.dropped = Math.max(0, queries.length - batch.length);

  for (const q of batch) {
    try {
      const ctx = await brandContext(env, q);
      const answer = await askEngine(env, opts.gen_model, q.query_text);
      const signal = await extractSignal(env, opts.extract_model, ctx.name, ctx.titles, answer);

      const obs: GeoObservation = {
        tenant_id: q.tenant_id,
        id: crypto.randomUUID(),
        query_id: q.id,
        brand_id: q.brand_id,
        engine: opts.gen_model,
        ts: now,
        brand_mentioned: signal.mentioned,
        rank: signal.rank,
        competitors: signal.competitors,
        products: signal.products,
        answer_excerpt: answer.slice(0, 2000),
      };
      await putObservation(env, obs);
      result.processed += 1;
      if (signal.mentioned) result.mentioned += 1;

      recordEventDetached(
        env,
        {
          tenantId: q.tenant_id,
          eventType: 'geo_observation',
          manifestId: q.brand_id,
          status: signal.mentioned ? 'mentioned' : 'absent',
          payload: {
            query_id: q.id,
            engine: opts.gen_model,
            rank: signal.rank,
            competitors: signal.competitors,
            products: signal.products,
            query_preview: q.query_text.slice(0, 200),
          },
        },
        execCtx,
      );
      recordCounter('orchestrator_geo_mention', {
        manifest_id: q.brand_id,
        engine: opts.gen_model,
        mentioned: signal.mentioned ? 'true' : 'false',
      });
      if (signal.rank > 0) {
        recordHistogram('orchestrator_geo_rank', signal.rank, {
          manifest_id: q.brand_id,
          engine: opts.gen_model,
        });
      }
    } catch (err) {
      console.error(`[geo-monitor] query ${q.tenant_id}/${q.id} failed:`, err);
    }
  }

  console.log(
    `[geo-monitor] tick — processed=${result.processed} mentioned=${result.mentioned} ` +
      `dropped=${result.dropped}`,
  );
  return result;
}
