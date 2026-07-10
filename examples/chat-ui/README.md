# Chat UI — streaming chat + a harness inspector

A React + Vite single-page app on **shadcn/ui + Tailwind CSS v4** that talks to Felix's public HTTP surface. Unlike the other examples (which front an *outbound* tool transport — sandbox, browser, queue, container), this one exercises Felix's *inbound* API and surfaces the harness's governance machinery alongside the chat.

The chat components follow the [Vercel AI Elements](https://ai-sdk.dev/elements) shape — a streaming `Conversation`, markdown `Response` (via [`streamdown`](https://www.npmjs.com/package/streamdown)), inline tool cards, a `Composer`, and a manifest selector — but are wired to Felix's SSE event model (`on_chat_model_stream` / `on_tool_start` / `on_tool_end` / `on_error`) rather than the AI SDK's `useChat`/`UIMessage`.

## What it demonstrates

**Chat (left):**
- **Multimodal composer** — the input is the AI-Elements `PromptInput` engine (ported from a production Felix chat UI): **attach images** (paperclip, drag-and-drop, or paste) with removable thumbnail previews, an **inline manifest picker**, **voice dictation** (Web Speech API, where supported), **slash commands** (`/new`, `/clear`, `/theme`), a live character counter, and Enter-to-send / Shift+Enter-for-newline. Attached images are inlined as base64 `data:` URLs and sent on the user turn.
- **Vision** — attachments ride on the chat request as `ChatMessage.attachments[]` (a Felix extension; see below) and the harness maps them to provider-native image blocks (Anthropic `image`, OpenAI `image_url`), so a vision-capable model actually *sees* the image. Attachments are analyzed on the turn you send them and are not persisted/replayed.
- **Streaming** — token deltas render live; `on_tool_start`/`on_tool_end` become collapsible tool cards, so the react tool loop is visible as it runs.
- **Greeting + suggested actions** — an empty conversation shows a welcome overview and a grid of starter prompts (the AI Elements `Greeting`/`SuggestedActions` shape); clicking one sends it as the first turn.
- **Message actions** — hovering a turn reveals **Copy** (any turn) and, on the last assistant turn, **Regenerate**. Because Felix's session log is append-only, regenerate resets the server transcript and replays the prior history up to the prompting user turn, then streams a fresh answer in place of the old one (rather than re-sending and double-counting the turn).
- **Theme toggle** — light / dark / system, persisted; tracks the OS preference live while on `system` (the `ModeToggle` shape, wired to the shadcn `.dark` tokens already in `index.css`).
- **Per-turn token usage** — each assistant turn shows the cumulative `input`/`output` tokens for that turn (all react sub-calls summed), read from a `usage` field the harness now stamps on the terminal `on_chain_end` frame.
- **Conversation history** (the History button, a left rail) — every thread is kept in `localStorage` (an index + a per-thread transcript blob); click a past conversation to resume it, or trash it to delete (best-effort server reset too). Each turn still sends *only the new user message* and Felix replays the thread server-side. On open, a thread is hydrated from the server event log (`GET /chat/history/{thread_id}`, reconstructed into the transcript) **when authenticated** — that route rejects anonymous callers, so the anonymous dev demo falls back to the `localStorage` copy. "New thread" starts a fresh one.
- **Manifest switcher** — the inline picker in the composer toolbar, populated from `GET /v1/models`.
- **Agent spec** (the 🤖 button in the header) — a read-only panel showing the *resolved* manifest the harness compiled for the selected agent: pattern, model + fallbacks, tools, skills, memory, session strategy, governance (judges/approvals/policies/limits), connectivity, and inbound auth (`GET /manifests/{name}`), plus the A2A discovery card for the default agent (`GET /.well-known/agent-card.json`).
- **Canary badge** — the `x-manifest-variant` response header (`stable`/`canary`).

**Inspector (right, toggleable) — the harness-parity panels:**
- **Activity** — polls `GET /audit`: a live feed of `tool_call`, `judge_score`, `guardrail_block`, `approval_request`/`approval_decision`, `plan_step`, `model_switch`, … events with type badges.
- **Metrics** — polls `GET /audit/metrics`: tool-call rollups over the last hour, folded per tool (total calls, error count, slowest avg latency) — the same `orchestrator_tool_calls` view an operator reads.
- **Approvals** — polls `GET /approvals?status=pending` and posts to `POST /approvals/:id/decide`: the human-in-the-loop queue with Approve / Deny.
- **Plans** — polls `GET /plans`: plan title + step statuses (populated by the `deep` pattern).
- **Skills** — shows the latest `list_skills` result captured from the stream, and a button that asks the agent to manage its skills (activation is model-driven via the `list_skills`/`activate_skill`/`deactivate_skill` tools — there's no REST surface).

**Eval workbench (header → "Eval", a slide-over):**
- The `/eval` offline-benchmark surface. Create a golden dataset, append items with a simplified rubric (`criteria` for the Workers-AI judge + `must_include` substring gates), then **Run vs `<manifest>`** to replay every item against the currently-selected agent and judge each response. Per-item pass/fail + scores come back inline (`POST /eval/datasets/{name}/run` → `GET /eval/runs`). Tenant-scoped; works anonymously.

**Scheduled jobs (header → "Jobs", a slide-over):**
- The `/jobs` registry — persistent, tenant-scoped cron-scheduled agent runs. Create a job (name + 5-field cron + manifest; empty cron = manual-only), watch `last_status`/`next_run_at`, and **Run now** to trigger one immediately (records a `job_run` event in the Activity feed). The cron sweep (`triggers.crons`) executes scheduled jobs automatically. Works anonymously (`GET /jobs/list`, `POST /jobs`, `POST /jobs/run/{name}`).

**Manifest lifecycle (header → "Manifests", a slide-over):**
- The `/manifests` surface — the append-only version log with active-pointer rollback and weighted canary. **Import** any resolvable manifest (e.g. the bundled `chat-ui-demo`) into the tenant version log, edit the JSON to **append a new version**, flip the **active pointer** to roll back, and drive a **weighted canary** with the slider. The canary routes traffic deterministically per thread, so the header's `stable`/`canary` badge flips for some **New thread**s once a canary is in flight. Writes need the `manifests:write` scope; local dev (no `JWT_VERIFIERS`) lets anonymous callers through.
  - *Demo:* Import `chat-ui-demo` → **New version** (tweak the `system_prompt`) → set that version as **canary @ 50%** → click **New thread** a few times and chat: ~half land on `canary`. **Rollback** zeros the weight.

These endpoints are tenant-scoped but allow anonymous callers (resolving to tenant `default`), so in the no-auth dev loop they read back exactly what your chat turns produce.

## The `chat-ui-demo` manifest

So the parity panels light up out of the box, the orchestrator ships a bundled manifest, `chat-ui-demo` (`manifests/chat-ui-demo.yaml`), that:
- declares the `concise-style` skill (Skills tab),
- gates the `calculator` tool behind **human approval** (Approvals tab — every calculation needs a decision), and
- runs an **on-topic judge** over every tool result (a `judge_score` per call in Activity).

Pick `chat-ui-demo` in the switcher and ask *"what is 7 × 6?"*: the calculator call is held for approval → approve it in the Inspector → re-send → `42`. For the Plans tab, switch to `deep` and ask a multi-step question.

> The manifest + skill are bundled into `src/manifests/bundled.ts` / `src/skills/bundled.ts` by `pnpm build:manifests` (run from the repo root). If `chat-ui-demo` isn't in the dropdown, run that and restart Felix.

## Why a proxy Worker

Felix serves no static assets and sets no CORS headers, so a browser app can't call it cross-origin. This example is a **standalone Worker** that (1) serves the built SPA (`./dist`) from a Workers Assets binding and (2) proxies `/api/*` to the Felix Worker over a **service binding**, stripping the `/api` prefix. Same-origin → no CORS changes to core. Returning the binding's `Response` verbatim preserves the streaming SSE body and the `x-manifest-variant` header. See [`worker/index.ts`](./worker/index.ts).

```
browser ──/api/*──▶ chat-ui Worker ──FELIX binding──▶ Felix
        ◀── SSE / JSON ──            ◀── SSE / JSON ──
```

## Local dev

Two terminals. The Vite dev server proxies `/api` to a locally-running Felix, mirroring the production Worker — so the front-end code is identical in both.

```bash
# repo root — bundle manifests (picks up chat-ui-demo), then run Felix on :8787
pnpm build:manifests
pnpm migrate:local      # first run only — creates the local D1 tables
pnpm dev

# this dir — SPA on :5173, /api → :8787
cd examples/chat-ui
pnpm install --ignore-workspace   # standalone project; the flag keeps the install out of the repo's pnpm workspace
pnpm dev
```

Open http://localhost:5173.

## Deploy

```bash
cp wrangler.example.jsonc wrangler.jsonc   # edit the service name if needed
pnpm build                                 # vite → ./dist
wrangler deploy
```

`services[].service` must match the deployed Felix Worker's `name` (`felix-orchestrator` by default). Build before deploy so `./dist` exists for the assets binding.

For a separate production deployment, keep a second config (e.g. `wrangler.prod.jsonc` pointing at the production Felix Worker + domain) and deploy with `wrangler deploy -c wrangler.prod.jsonc`.

## Files

| Path | Purpose |
|---|---|
| `worker/index.ts` | Proxy Worker: serves assets, forwards `/api/*` to the `FELIX` binding |
| `src/api.ts` | SSE client for `/chat/stream` + REST helpers for `/v1/models`, `/audit`, `/approvals`, `/plans` |
| `src/types.ts` | Wire types mirrored from `src/api/{openapi-shared,chat,audit,approvals,plans}.ts` |
| `src/components/chat/` | `Conversation`, `Response`, `Message`, `MessageActions`, `Tool`, `MultimodalInput`, `PreviewAttachment`, `SlashCommandMenu`, `Greeting`, `SuggestedActions` |
| `src/components/ai-elements/prompt-input.tsx` | The AI-Elements `PromptInput` engine (attachments, drag/drop, paste, controlled state) |
| `src/hooks/use-speech-recognition.ts` | Web Speech API voice-dictation hook |
| `src/components/theme-provider.tsx`, `theme-toggle.tsx` | Light/dark/system theme context + `ModeToggle` |
| `src/components/inspector/` | The Activity / Metrics / Approvals / Plans / Skills panel |
| `src/components/eval/` | The `/eval` workbench slide-over (datasets, items, runs) |
| `src/components/manifests/` | The `/manifests` lifecycle slide-over (versions, rollback, canary) |
| `src/components/jobs/` | The `/jobs` scheduled-jobs slide-over (create, list, run-now) |
| `src/components/agent/` | The agent-spec slide-over (resolved manifest + A2A card) |
| `src/components/chat/thread-list.tsx` | The conversation-history left rail |
| `src/lib/threads.ts` | Multi-thread localStorage + event-log → transcript rebuild |
| `src/components/ui/` | shadcn/ui primitives (added via `npx shadcn add`) |
| `src/hooks/usePoll.ts` | Interval poller used by the Inspector tabs |
| `components.json`, `src/index.css` | shadcn config + Tailwind v4 theme tokens |

## Notes

- **Vision (a core extension).** Image attachments required a small, backward-compatible change to the harness itself: `ChatMessageSchema` gained an optional `attachments: { url, media_type, filename? }[]` (`src/api/openapi-shared.ts`), `ChatMessage` carries it through (`src/patterns/types.ts`), and the model adapter maps it to provider-native image blocks — Anthropic `image` (base64 / url source), OpenAI `image_url` (`src/patterns/model.ts`). Workers AI ignores attachments. Attachments are *not* written to the session log (`chatMessageToEvent` skips them), so they're analyzed once on the turn they're sent rather than re-fed on every replay. Covered by `tests/unit/multimodal_vision.test.ts`. To actually see images analyzed, pick a vision-capable model in `MODEL_ROUTES`.
- **Auth.** Bundled manifests and the Inspector endpoints work anonymously in dev (tenant `default`). Behind real auth, have the proxy Worker inject an `Authorization` header before forwarding (or run Felix behind Cloudflare Access and let the JWT flow through). `GET /chat/history/:thread_id` hard-rejects anonymous, so the transcript is restored from `localStorage` rather than that route.
- **Bundle size.** `streamdown` bundles `shiki` (and mermaid) for code/diagram rendering; syntax grammars are code-split and lazy-loaded. Fine for a demo; swap `Response` for a lighter markdown renderer if you need a smaller bundle.
- **Adapting AI Elements.** The chat components are original, built on the same libraries AI Elements use (`streamdown`, `use-stick-to-bottom`, shadcn primitives) and adapted to Felix's SSE events instead of the AI SDK data model.
