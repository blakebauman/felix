/**
 * Entity connectors — the 3p integration mechanisms. Open registry:
 * `registerEntityConnector(kind, factory)`. Built-ins:
 *
 *   http — GET `${url}/${type}/${id}` (one) and `${url}/${type}?limit&cursor`
 *          (page); list response is `{ items: [...], cursor? }` or a bare array.
 *   mcp  — JSON-RPC `tools/call` to `get_${type}` / `list_${type}` on an MCP
 *          server; the tool's JSON text content is the record(s).
 *
 * Both are SSRF-guarded and send an outbound `Authorization` header from the
 * connector config (a literal `Bearer …` or a broker marker — resolution is the
 * caller's concern; here we forward whatever string was configured).
 */

import { assertSafeOutboundUrlForEnv } from '@felix/harness/security/ssrf';
import type { ConnectorConfig, ConnectorCtx, EntityConnector, ListOpts, RawRecord } from './types';

type ConnectorFactory = (cfg: ConnectorConfig) => EntityConnector;

const factories = new Map<string, ConnectorFactory>();

export function registerEntityConnector(kind: string, factory: ConnectorFactory): void {
  factories.set(kind, factory);
}

export function getEntityConnector(cfg: ConnectorConfig): EntityConnector {
  const factory = factories.get(cfg.kind);
  if (!factory) {
    throw new Error(
      `Unknown entity connector: ${cfg.kind} (registered: ${[...factories.keys()].join(', ')})`,
    );
  }
  return factory(cfg);
}

function authHeaders(cfg: ConnectorConfig): Record<string, string> {
  return cfg.auth ? { authorization: cfg.auth } : {};
}

function asRecords(body: unknown): { records: RawRecord[]; cursor?: string } {
  if (Array.isArray(body)) return { records: body as RawRecord[] };
  if (body && typeof body === 'object') {
    const obj = body as { items?: unknown; cursor?: unknown };
    if (Array.isArray(obj.items)) {
      return {
        records: obj.items as RawRecord[],
        cursor: typeof obj.cursor === 'string' ? obj.cursor : undefined,
      };
    }
  }
  return { records: [] };
}

// ---- http ----

class HttpConnector implements EntityConnector {
  readonly kind = 'http';
  constructor(private readonly cfg: ConnectorConfig) {}

  async fetchOne(type: string, id: string, ctx: ConnectorCtx): Promise<RawRecord | null> {
    const url = `${this.cfg.url.replace(/\/$/, '')}/${type}/${encodeURIComponent(id)}`;
    assertSafeOutboundUrlForEnv(url, ctx.env);
    const resp = await fetch(url, { headers: authHeaders(this.cfg), signal: ctx.signal });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`http connector ${type}/${id}: ${resp.status}`);
    return (await resp.json()) as RawRecord;
  }

  async fetchPage(type: string, opts: ListOpts, ctx: ConnectorCtx) {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString();
    const url = `${this.cfg.url.replace(/\/$/, '')}/${type}${qs ? `?${qs}` : ''}`;
    assertSafeOutboundUrlForEnv(url, ctx.env);
    const resp = await fetch(url, { headers: authHeaders(this.cfg), signal: ctx.signal });
    if (!resp.ok) throw new Error(`http connector list ${type}: ${resp.status}`);
    return asRecords(await resp.json());
  }
}

// ---- mcp ----

async function mcpCall(
  url: string,
  tool: string,
  args: Record<string, unknown>,
  cfg: ConnectorConfig,
  ctx: ConnectorCtx,
): Promise<unknown> {
  assertSafeOutboundUrlForEnv(url, ctx.env);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(cfg) },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
    signal: ctx.signal,
  });
  if (!resp.ok) throw new Error(`mcp connector ${tool}: ${resp.status}`);
  const data = (await resp.json()) as {
    error?: { code: number; message: string };
    result?: { content?: Array<{ type: string; text?: string }> };
  };
  if (data.error) throw new Error(`mcp connector error: ${data.error.message}`);
  const text = (data.result?.content ?? [])
    .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
    .join('\n')
    .trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

class McpConnector implements EntityConnector {
  readonly kind = 'mcp';
  constructor(private readonly cfg: ConnectorConfig) {}

  private tool(action: 'get' | 'list', type: string): string {
    const tmpl = (this.cfg.options?.[`${action}_tool`] as string) || `${action}_${type}`;
    return tmpl;
  }

  async fetchOne(type: string, id: string, ctx: ConnectorCtx): Promise<RawRecord | null> {
    const out = await mcpCall(this.cfg.url, this.tool('get', type), { id }, this.cfg, ctx);
    return out && typeof out === 'object' ? (out as RawRecord) : null;
  }

  async fetchPage(type: string, opts: ListOpts, ctx: ConnectorCtx) {
    const out = await mcpCall(this.cfg.url, this.tool('list', type), { ...opts }, this.cfg, ctx);
    return asRecords(out);
  }
}

registerEntityConnector('http', (cfg) => new HttpConnector(cfg));
registerEntityConnector('mcp', (cfg) => new McpConnector(cfg));
