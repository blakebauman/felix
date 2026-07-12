/**
 * SSRF guard for outbound URLs that come from manifests (mcp_servers, peers)
 * or from any other tenant-controlled source.
 *
 * Two layers:
 *   - `assertSafeOutboundUrl(url)` is a parse-time check used by the manifest
 *     Zod schema. It can't see the env, so it only enforces the universal
 *     rules: must be HTTPS (or HTTP to `localhost` in dev), reject loopback,
 *     RFC1918, link-local (incl. AWS/GCP IMDS at 169.254.169.254), and
 *     unique-local IPv6 ranges.
 *   - `assertSafeOutboundUrlForEnv(url, env)` runs the same checks plus an
 *     optional explicit allow-list from `env.SSRF_ALLOW_HOSTS` (comma-
 *     separated hostnames). Called right before each outbound fetch so a
 *     bundled manifest can't be coerced into hitting an internal target
 *     even if it slipped past parse-time validation.
 *
 * The private-host check does NOT rely on the literal's textual form. It
 * canonicalizes any IP literal first — decimal (`2130706433`), octal
 * (`0177.0.0.1`), hex (`0x7f.0.0.1`), short-form (`127.1`), and IPv4-mapped
 * IPv6 (`[::ffff:169.254.169.254]`) all resolve to the same address before the
 * range check runs — so alternate encodings can't smuggle a request to
 * loopback/RFC1918/IMDS.
 *
 * We deliberately do NOT do DNS lookups: workerd doesn't expose resolution
 * and the threat model is "manifest author pointed at a private host" not
 * "manifest author registered a public DNS name that resolves to a private
 * IP". A defender who wants the latter can add a CIDR-based egress firewall
 * at the Cloudflare network layer.
 */

import type { Env } from '../env';

const BLOCKED_HOST_SUFFIXES = ['.internal', '.cluster.local', '.svc', '.svc.cluster.local'];

/** IPv4 CIDR blocks that must never be reachable from an outbound fetch. */
const BLOCKED_V4_CIDRS: Array<[base: number, bits: number]> = [
  [0x00000000, 8], // 0.0.0.0/8   "this host"
  [0x0a000000, 8], // 10.0.0.0/8  RFC1918
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (incl. AWS/GCP IMDS 169.254.169.254)
  [0xac100000, 12], // 172.16.0.0/12 RFC1918
  [0xc0a80000, 16], // 192.168.0.0/16 RFC1918
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
];

function v4InBlockedRange(n: number): boolean {
  for (const [base, bits] of BLOCKED_V4_CIDRS) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === (base & mask) >>> 0) return true;
  }
  return false;
}

/**
 * Parse a single IPv4 octet in decimal, octal (`0`-prefixed), or hex
 * (`0x`-prefixed) form — matching the classic inet_aton lexer that the
 * platform's URL/socket layer uses.
 */
function parseV4Part(p: string): number | null {
  if (p === '') return null;
  let v: number;
  if (/^0x[0-9a-f]+$/i.test(p)) v = Number.parseInt(p.slice(2), 16);
  else if (/^0[0-7]+$/.test(p)) v = Number.parseInt(p, 8);
  else if (/^[0-9]+$/.test(p)) v = Number.parseInt(p, 10);
  else return null;
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * inet_aton-style IPv4 parse: accepts 1–4 parts where the final part fills the
 * remaining low-order bytes (`127.1` → 127.0.0.1, `2130706433` → 127.0.0.1).
 * Returns the 32-bit address, or null if the host is not an IPv4 literal.
 */
function parseIpv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const v = parseV4Part(p);
    if (v === null) return null;
    nums.push(v);
  }
  const n = nums.length;
  for (let i = 0; i < n - 1; i += 1) if (nums[i]! > 0xff) return null;
  const last = nums[n - 1]!;
  const maxLast = [0xffffffff, 0xffffff, 0xffff, 0xff][n - 1]!;
  if (last > maxLast) return null;
  let result = last;
  for (let i = 0; i < n - 1; i += 1) result += nums[i]! * 2 ** (8 * (n - 1 - i));
  return result >= 0 && result <= 0xffffffff ? result >>> 0 : null;
}

/** Strict dotted-quad parse (each octet 0–255, exactly 4 parts) for the tail of an IPv4-mapped IPv6. */
function parseDottedQuad(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const p of parts) {
    if (!/^[0-9]{1,3}$/.test(p)) return null;
    const v = Number.parseInt(p, 10);
    if (v > 255) return null;
    result = (result << 8) | v;
  }
  return result >>> 0;
}

/** Parse an IPv6 literal (one `::` allowed, optional embedded IPv4 tail) to 16 bytes, or null. */
function parseIpv6(input: string): Uint8Array | null {
  let s = input;
  const pct = s.indexOf('%'); // strip zone id
  if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(':')) return null;

  // Rewrite an embedded dotted-quad tail (::ffff:127.0.0.1) into two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseDottedQuad(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  let groups: number[];
  if (halves.length === 2) {
    const left = parseGroups(halves[0]!);
    const right = parseGroups(halves[1]!);
    if (!left || !right) return null;
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else {
    const g = parseGroups(halves[0]!);
    if (!g) return null;
    groups = g;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    bytes[2 * i] = (groups[i]! >> 8) & 0xff;
    bytes[2 * i + 1] = groups[i]! & 0xff;
  }
  return bytes;
}

function ipv6IsBlocked(b: Uint8Array): boolean {
  const allZeroThrough = (end: number) => {
    for (let i = 0; i < end; i += 1) if (b[i] !== 0) return false;
    return true;
  };
  // ::  (unspecified) and ::1 (loopback)
  if (allZeroThrough(15) && (b[15] === 0 || b[15] === 1)) return true;
  // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true;
  // fc00::/7 unique-local
  if ((b[0]! & 0xfe) === 0xfc) return true;
  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 — range-check the embedded v4.
  const mappedFfff = allZeroThrough(10) && b[10] === 0xff && b[11] === 0xff;
  const compat = allZeroThrough(12);
  if (mappedFfff || compat) {
    const v4 = ((b[12]! << 24) | (b[13]! << 16) | (b[14]! << 8) | b[15]!) >>> 0;
    // A bare ::/96 with a non-private, non-zero v4 is not a real reachable
    // address; only treat the embedded v4 as blocked when it's in a private range.
    if (v4InBlockedRange(v4)) return true;
  }
  return false;
}

function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase();
  const bare = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;

  if (bare === 'localhost') return true;
  if (BLOCKED_HOST_SUFFIXES.some((s) => lower.endsWith(s) || bare.endsWith(s))) return true;

  const v4 = parseIpv4(bare);
  if (v4 !== null) return v4InBlockedRange(v4);

  const v6 = parseIpv6(bare);
  if (v6 !== null) return ipv6IsBlocked(v6);

  return false;
}

function parseAllowHosts(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface SsrfCheckOptions {
  /** Permit `http://localhost` / `http://127.0.0.1` — only in development. */
  allowLocalhostInsecure?: boolean;
  /** Explicit hostname allow-list, e.g. from env.SSRF_ALLOW_HOSTS. */
  allowedHosts?: Set<string>;
}

/**
 * Parse-time / standalone SSRF check. Throws on rejection so it can be used
 * inside Zod `.refine()` (the wrapper converts the throw into a parse error).
 */
export function assertSafeOutboundUrl(rawUrl: string, opts: SsrfCheckOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid url');
  }

  const host = url.hostname.toLowerCase();
  const allowedHosts = opts.allowedHosts;
  const isAllowlisted = allowedHosts?.has(host) ?? false;

  const localhostDevAllowed =
    opts.allowLocalhostInsecure && (host === 'localhost' || host === '127.0.0.1');

  // Scheme: HTTPS required, with a narrow HTTP-to-localhost dev exception. The
  // allow-list can waive the private-host check (below) but NOT the scheme —
  // an allow-listed host is still only reachable over HTTPS in production.
  if (url.protocol === 'http:') {
    if (!localhostDevAllowed) {
      throw new Error(`http: scheme not allowed (host=${host})`);
    }
  } else if (url.protocol !== 'https:') {
    throw new Error(`scheme not allowed: ${url.protocol}`);
  }

  // Explicit allow-list waives the private-range check (the scheme rule above
  // already ran) so an operator can deliberately reach an internal host.
  if (isAllowlisted) return url;

  if (isPrivateHost(host) && !localhostDevAllowed) {
    throw new Error(`private/loopback host not allowed: ${host}`);
  }

  return url;
}

/**
 * Runtime SSRF check. Reads the explicit allow-list from `env.SSRF_ALLOW_HOSTS`
 * and the dev-mode flag from `env.ENVIRONMENT`. Called at the fetch site
 * (mcp/client.ts, a2a/client.ts) — never trust that the parse-time check ran.
 */
export function assertSafeOutboundUrlForEnv(rawUrl: string, env: Env): URL {
  return assertSafeOutboundUrl(rawUrl, {
    allowLocalhostInsecure: env.ENVIRONMENT === 'development',
    allowedHosts: parseAllowHosts(env.SSRF_ALLOW_HOSTS),
  });
}

/**
 * True when a `fetch(..., { redirect: 'manual' })` response is a redirect the
 * caller must NOT follow. The SSRF guard only validates the *initial* URL, so
 * a 3xx to an internal address (IMDS / RFC1918 / `.internal`) would bypass it
 * if followed. In the Workers runtime `redirect: 'manual'` surfaces the raw
 * 3xx (status + Location intact) rather than a browser-style opaque-redirect,
 * so a status-range check is sufficient. Callers that expect no redirects
 * (JSON-RPC / gateway POST endpoints) throw on a hit.
 */
export function isRedirect(resp: Response): boolean {
  return resp.status >= 300 && resp.status < 400;
}

/**
 * Convenience predicate used by `outboundAuthHeader` so we never attach a
 * bearer to a non-allowlisted (or private) host.
 */
export function isOutboundHostAllowed(rawUrl: string, env: Env): boolean {
  try {
    assertSafeOutboundUrlForEnv(rawUrl, env);
    return true;
  } catch {
    return false;
  }
}
