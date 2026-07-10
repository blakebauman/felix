# Browser adapter — wiring `@cloudflare/puppeteer` to Felix's `browser` transport

Reference Worker that bridges Felix's `BrowserExecutor` (`transport: 'browser'`, seventh tool transport) to Cloudflare Browser Rendering via [`@cloudflare/puppeteer`](https://www.npmjs.com/package/@cloudflare/puppeteer). Deploy separately, bind into Felix as a Service binding, and any manifest declaring `spec.browser_tools[]` will route through it.

```
Felix manifest                    this Worker                       Cloudflare
(spec.browser_tools[]) ─Service─► POST /{op}  ──@cloudflare/puppeteer──►  Browser Rendering
                        binding    { url,                                  (Chromium)
                                     options,
                                     session,
                                     timeout_ms }
```

The brain sees a normal tool: `fetch_page({ url: "https://example.com" })`. Felix routes the call through `BrowserExecutor`, which POSTs `/{op}` to this Worker. The Worker spins up a Chromium session, runs the op, and returns the body — HTML for `content`, JSON for `links`/`snapshot`, a `data:image/png;base64,...` URI for `screenshot`/`pdf`.

## Files

- `adapter.ts` — ~130 lines. One `fetch()` handler, an op switch covering `content`, `links`, `snapshot`, `screenshot`, `pdf`, `json`.
- `wrangler.example.jsonc` — Browser Rendering binding declaration.

## Wiring

```jsonc
// 1. This Worker (adapter.ts): see wrangler.example.jsonc

// 2. Felix's wrangler.jsonc — bind this Worker as a Service binding
"services": [{ "binding": "BROWSER", "service": "felix-browser-worker" }],
```

```yaml
# 3. Felix manifest — declare the browser tools the model should see
spec:
  browser_tools:
    - name: fetch_page
      binding: BROWSER         # matches the Service binding above
      op: content              # returns HTML
      timeout_ms: 30000

    - name: page_links
      binding: BROWSER
      op: links                # returns JSON: string[] of absolute hrefs

    - name: page_screenshot
      binding: BROWSER
      op: screenshot           # returns "data:image/png;base64,..." text

    - name: fetch_json
      binding: BROWSER
      op: json                 # skips Chromium — straight HTTPS pass-through
```

## Ops

| op           | response shape                                  | when to use                                                   |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------- |
| `content`    | `text/html` — the rendered DOM                  | Default. Model reads the page as HTML.                        |
| `links`      | JSON `string[]` — deduped absolute hrefs        | Crawl planning, link extraction.                              |
| `snapshot`   | JSON `{ html, screenshot_base64 }`              | "Look at this page" — visual + DOM in one round trip.         |
| `screenshot` | `data:image/png;base64,...` text                | Pair with a vision-capable model (Anthropic, OpenAI).         |
| `pdf`        | `data:application/pdf;base64,...` text          | Print-friendly snapshot for archival or downstream parsing.   |
| `json`       | response body verbatim (passthrough)            | Skip Chromium for endpoints that already return JSON.         |

`json` is the cost optimisation — Browser Rendering isn't cheap, and for "just GET this JSON" calls a direct `fetch` saves the launch.

## Sessions

Browser Rendering doesn't expose multi-call session reuse off a single binding the way Sandbox does — each `puppeteer.launch` is a fresh browser. The `session` field Felix passes through is currently only useful for audit correlation; if browser-state continuity (cookies, localStorage, navigation history) becomes important, a follow-up would add a session pool keyed by threadId here.

## Failure modes

1. **Navigation timeout** — surfaces as HTTP 502 → `BrowserExecutor` returns a `[browser error]` ToolOutput tagged `provider_error`. Tune via `timeout_ms` on the manifest entry.
2. **Browser Rendering rate limit** — Browser Rendering returns 429 when you exceed concurrency or quota. `codeForStatus` maps that to `rate_limited`; the model sees the deny and can retry later.
3. **`page.goto` throws on a bad URL** — same path as a timeout: 502, `provider_error`.
4. **Browser launch fails (binding misconfig, quota exhausted)** — returned as HTTP 503; surfaces as `transport_unavailable`.

## Cost / safety

Browser Rendering is paid per-second of active session time. Two things to do:

1. **`limits.max_tool_calls`** on any manifest that exposes browser tools. Hard cap per run.
2. **`spec.guardrails.judges`** scoring the page content for relevance before the model uses it — keeps the agent from chewing through Chromium time on irrelevant pages.

## Run it locally

Browser Rendering requires a paid Workers plan and account-level provisioning; local `wrangler dev` mocks the binding only loosely. The realistic dev path is to deploy to staging:

```bash
cd examples/browser-worker
pnpm dlx wrangler deploy --env staging
```

Then exercise the running adapter:

```bash
curl -s https://felix-browser-worker.<account>.workers.dev/content \
  -H 'content-type: application/json' \
  -d '{ "url": "https://example.com", "session": "demo:thread-1" }' | head -c 500
```

## Why a separate Worker (not inline)

Same reason `examples/sandbox-worker/` and `examples/queue-consumer/` are separate: brain/hands decoupling. Browser Rendering's launch latency and per-second cost are deployment concerns that should fail independently of the orchestrator. Felix sees `env.BROWSER` as a generic `Fetcher` — swap this adapter for a self-hosted Chromium service, a Browserless instance, or a different upstream browser SaaS, and the manifest doesn't change.
