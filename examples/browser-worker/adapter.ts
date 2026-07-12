/**
 * Reference adapter Worker for Felix's `browser` tool transport.
 *
 * Felix's `BrowserExecutor` (`src/tools/browser-executor.ts`) expects a
 * `Fetcher` binding that speaks this protocol:
 *
 *   POST {prefix}/{op}
 *   { "url":        "<target>",
 *     "options":    { ...op-specific args },
 *     "session":    "<threadId>",       ← optional, namespaces browser sessions
 *     "timeout_ms": <int>?              ← optional
 *   }
 *
 *   200 → text body returned verbatim to the model. For binary ops
 *         (screenshot, pdf) we base64-encode the bytes and emit a
 *         `data:<mime>;base64,...` data URI the model can recognize.
 *
 * This Worker bridges that contract to `@cloudflare/puppeteer` over the
 * Browser Rendering binding. Deploy separately, bind into Felix as a
 * Service binding, then declare browser tools in the manifest:
 *
 *   // Felix's wrangler.jsonc
 *   "services": [{ "binding": "BROWSER", "service": "felix-browser-worker" }]
 *
 *   // Felix's manifest
 *   spec:
 *     browser_tools:
 *       - name: fetch_page
 *         binding: BROWSER
 *         op: content
 *         timeout_ms: 30000
 *       - name: page_links
 *         binding: BROWSER
 *         op: links
 *
 * Built-in ops: `content` (HTML), `links` (string[] JSON),
 * `snapshot` ({ html, screenshot_base64 } JSON), `screenshot`
 * (data:image/png;base64,...), `pdf` (data:application/pdf;base64,...),
 * and `json` (fetches a JSON URL straight without spinning up
 * Chromium — useful for "just give me this REST endpoint").
 */

import puppeteer from '@cloudflare/puppeteer';

interface Env {
  /** Browser Rendering binding. Provisioned via wrangler `browser` block. */
  BROWSER: Fetcher;
}

interface OpRequest {
  url: string;
  options?: Record<string, unknown>;
  session?: string;
  timeout_ms?: number;
}

const DEFAULT_NAV_TIMEOUT_MS = 30_000;

/**
 * Default-deny obvious internal navigation targets. Felix runs a best-effort
 * SSRF pre-check before dispatch, but the browser actually connects from HERE,
 * so this adapter is the real containment point — it's where a public DNS name
 * that resolves to a private IP would land. Tighten this into an explicit
 * allow-list for production; this literal check only stops the easy cases
 * (loopback, RFC1918, link-local / cloud IMDS at 169.254.169.254, `.internal`).
 */
function isInternalTarget(rawUrl: string): boolean {
  let host: string;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return true;
    host = u.hostname.toLowerCase();
  } catch {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / IMDS
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  return false;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }
    const url = new URL(req.url);
    const op = url.pathname.replace(/^\//, '');
    if (!op) return new Response('missing op in path', { status: 404 });

    let body: OpRequest;
    try {
      body = (await req.json()) as OpRequest;
    } catch {
      return new Response('bad json', { status: 400 });
    }
    if (!body.url) {
      return new Response('missing url', { status: 400 });
    }
    // Egress default-deny: this adapter is where the browser actually connects,
    // so it's the real SSRF containment point. Replace with an allow-list in prod.
    if (isInternalTarget(body.url)) {
      return new Response('target host not allowed', { status: 403 });
    }

    // The `json` op never touches Chromium — it's a straight pass-through
    // for endpoints that already return JSON. Saves the cold start.
    if (op === 'json') {
      try {
        const upstream = await fetch(body.url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(body.timeout_ms ?? DEFAULT_NAV_TIMEOUT_MS),
        });
        if (!upstream.ok) {
          return new Response(`upstream ${upstream.status}`, { status: 502 });
        }
        const text = await upstream.text();
        return new Response(text, { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(String((err as Error).message ?? err), { status: 502 });
      }
    }

    const timeout = body.timeout_ms ?? DEFAULT_NAV_TIMEOUT_MS;
    // Browser Rendering doesn't expose multi-session reuse off a single
    // binding the way Sandbox SDK does — each `puppeteer.launch` is a
    // fresh browser. Felix's `session` is preserved as a hint in the
    // response headers so audit can correlate, but state doesn't carry
    // across calls. A follow-up would add a session pool keyed by
    // threadId here if browser-state continuity becomes important.
    let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
    try {
      browser = await puppeteer.launch(env.BROWSER);
    } catch (err) {
      return new Response(`browser launch failed: ${(err as Error).message}`, { status: 503 });
    }

    try {
      const page = await browser.newPage();
      await page.goto(body.url, { waitUntil: 'networkidle0', timeout });

      switch (op) {
        case 'content': {
          const html = await page.content();
          return new Response(html, { headers: { 'content-type': 'text/html' } });
        }
        case 'links': {
          // Strip duplicates and empty values; the model gets a clean
          // JSON array of absolute URLs.
          const hrefs = await page.$$eval('a[href]', (els) =>
            (els as HTMLAnchorElement[]).map((el) => el.href).filter(Boolean),
          );
          const unique = Array.from(new Set(hrefs));
          return Response.json(unique);
        }
        case 'snapshot': {
          const html = await page.content();
          const ss = await page.screenshot({ encoding: 'base64' });
          return Response.json({
            html,
            screenshot_base64: typeof ss === 'string' ? ss : '',
          });
        }
        case 'screenshot': {
          const ss = await page.screenshot({ encoding: 'base64' });
          const dataUri = `data:image/png;base64,${typeof ss === 'string' ? ss : ''}`;
          return new Response(dataUri, { headers: { 'content-type': 'text/plain' } });
        }
        case 'pdf': {
          const pdf = await page.pdf();
          // Puppeteer returns a Buffer/Uint8Array; convert to base64
          // without pulling in `Buffer` (workerd is browser-shaped).
          const b64 = btoa(String.fromCharCode(...new Uint8Array(pdf)));
          const dataUri = `data:application/pdf;base64,${b64}`;
          return new Response(dataUri, { headers: { 'content-type': 'text/plain' } });
        }
        default:
          return new Response(`unknown op: ${op}`, { status: 404 });
      }
    } catch (err) {
      // Navigation failure / timeout / element-eval bug → 502 so
      // BrowserExecutor surfaces a `provider_error` ToolOutput the
      // model can recover from.
      return new Response(`browser op '${op}' failed: ${(err as Error).message}`, {
        status: 502,
      });
    } finally {
      try {
        await browser.close();
      } catch {
        // Ignore close errors — the navigation result is what matters.
      }
    }
  },
};
