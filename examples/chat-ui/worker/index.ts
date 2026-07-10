/**
 * Proxy Worker for the Felix chat UI.
 *
 * Two responsibilities, both same-origin so the browser never makes a
 * cross-origin request (no CORS needed on Felix):
 *
 *   1. /api/*  → strip the `/api` prefix and forward to the FELIX service
 *               binding. The binding's Response is returned verbatim, which
 *               preserves the streaming SSE body of /chat/stream *and* the
 *               x-manifest-variant response header.
 *   2. else    → serve the built SPA from the ASSETS binding.
 *
 * This mirrors the Vite dev proxy (see vite.config.ts) so the front-end code
 * is identical in dev and production.
 */

interface Env {
  FELIX: Fetcher;
  ASSETS: Fetcher;
  // Optional shared access key. When set (`wrangler secret put CHAT_UI_KEY`),
  // every /api/* request must carry a matching `x-chat-key` header. Unset →
  // the proxy is open (the example's default, anonymous behaviour).
  CHAT_UI_KEY?: string;
}

/** Length-safe constant-time string compare (avoids early-exit timing leaks). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/api/')) {
      // Shared-key gate. Only enforced when CHAT_UI_KEY is configured, so the
      // example still runs unsecured out of the box. Assets stay public so the
      // SPA (and its key prompt) can always load.
      if (env.CHAT_UI_KEY) {
        const provided = req.headers.get('x-chat-key') ?? '';
        if (!timingSafeEqual(provided, env.CHAT_UI_KEY)) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
      }

      const rest = url.pathname.slice('/api'.length); // keep the leading slash
      const target = `https://felix${rest}${url.search}`;
      // Reuse the inbound request (method, headers, body, signal) against the
      // rewritten URL so POST bodies and streaming both flow through.
      return env.FELIX.fetch(new Request(target, req));
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
