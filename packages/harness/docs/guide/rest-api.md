---
description: "All Felix public HTTP endpoints — /chat, /v1, /a2a, /mcp, /health, /.well-known — with curl examples, auth notes, and streaming."
---

# REST API

The public HTTP surface. Every route runs through `authMiddleware` (verifies JWT, populates `RequestContext`) and `rateLimitMiddleware` (per-tenant sliding window of 100 req/60s). `/health`, `/.well-known/*`, `/docs`, `/openapi.json` are exempt from rate limiting.

A few mounts are **self-authenticating** — the middleware still runs, but JWT verification is skipped in favor of the mount's own scheme: `/acp/*` (constant-time `ACP_API_KEY` bearer), `/internal/*` and `/entities/:type/push` (`x-consumer-secret` shared secret), and the Stripe webhooks (`/commerce/stripe/webhook`, `/b2b/billing/webhook` — Stripe signature verification).

For the management surfaces (audit, plans, jobs, approvals, manifests, eval), see [management-api.md](management-api.md). For the commerce surfaces (`/acp`, `/shop`, `/widget`, `/structured`, `/brands`, `/b2b`, `/entities`, `/geo`, consent/attribution), see [the commerce docs](../../../commerce/docs/index.md).

## Conventions

- Examples below use `$BASE_URL` — set it to your deployment, e.g. `export BASE_URL=http://localhost:8787` for `pnpm dev`, or `https://make.felix.run` in production.
- All bodies are `application/json` unless noted.
- Streaming endpoints emit `text/event-stream`.
- Authentication is by `Authorization: Bearer <jwt>`. Anonymous calls (no header) succeed only on manifests with `auth.inbound.allow_anonymous: true`. Invalid or expired tokens return 401 (they do **not** silently demote to anonymous).
- Thread ids in client-visible APIs are **suffixes**; the server enforces a `${tenantId}:` prefix and rejects suffixes containing `:` or `#` with 400.
- Rate limited requests return HTTP 429.

---

## GET /health

Liveness probe plus active federation `PolicyBundle` metadata. Public; no auth.

```bash
curl -s $BASE_URL/health | jq
```

```json
{
  "status": "ok",
  "env": "development",
  "multi_region": false,
  "federation": null
}
```

When a signed bundle has loaded from R2, `federation` is `{ "bundleVersion": "...", "issuer": "..." }`.

---

## GET /.well-known/agent-card.json

A2A discovery document for the default manifest (configured at `createApp({ defaultManifest })` time; currently `quick`). Public; no auth.

```bash
curl -s $BASE_URL/.well-known/agent-card.json | jq
```

```json
{
  "name": "quick",
  "description": "",
  "version": "1.0.0",
  "protocols": ["a2a/jsonrpc/2.0", "openai/chat/v1", "mcp/sse"],
  "endpoints": {
    "a2a": "http://localhost:8787/a2a",
    "mcp": "http://localhost:8787/mcp"
  },
  "auth": {
    "schemes": [],
    "required_scopes": [],
    "allow_anonymous": true
  },
  "capabilities": [],
  "federation": null
}
```

See `src/a2a/card.ts:13-50` for the exact shape.

---

## GET /openapi.json

OpenAPI 3.1.0 specification covering the core routes — discovery (`/health`, `/.well-known/agent-card.json`), OpenAI-compatible chat (`/v1/*`), Felix-native chat with SSE (`/chat/*`), JSON-RPC protocols (`/a2a`, `/mcp`), tenant manifest CRUD (`/manifests/*`), eval datasets and runs (`/eval/*`), and management (`/audit`, `/audit/metrics`, `/approvals`, `/plans`, `/jobs`). The commerce routers (`/acp`, `/shop`, `/widget`, `/structured`, `/brands`, `/b2b`, `/entities`, `/geo`, consent) are plain Hono routers and do **not** appear in the spec — see [the commerce docs](../../../commerce/docs/index.md) for those. Treat the spec as authoritative for the routes it covers; the prose below is for orientation.

```bash
curl -s $BASE_URL/openapi.json | jq '.paths | keys'
```

## GET /docs

Scalar API reference UI rendered from `/openapi.json`. Open `$BASE_URL/docs` in a browser — endpoints are grouped by tag (`System`, `OpenAI`, `Threads`, `A2A`, `MCP`, `Manifests`, `Audit`, `Approvals`, `Plans`, `Jobs`) with request/response schemas, examples, and an `Authorize` button for the `bearerAuth` scheme.

---

## GET /v1/models

Lists every bundled manifest as an OpenAI-shaped model entry.

```bash
curl -s $BASE_URL/v1/models | jq
```

```json
{
  "object": "list",
  "data": [
    { "id": "quick", "object": "model", "created": 0, "owned_by": "orchestrator" }
  ]
}
```

## POST /v1/chat/completions

OpenAI-compatible chat completions. Any OpenAI SDK should work — point it at `$BASE_URL/v1` and use a manifest name as the `model`.

**Headers**

| Header | Purpose |
|---|---|
| `Authorization: Bearer <jwt>` | Required if the target manifest's `auth.inbound.allow_anonymous` is false. |
| `x-thread-id` | Optional thread suffix. Without it, each request is stateless and gets a fresh `${tenant}:openai-<uuid>` thread. Suffixes containing `:` or `#` return 400. Also seeds the canary bucket — a single thread stays on one variant across the rollout. |
| `x-manifest-version` | Optional positive integer pinning a specific tenant-managed manifest version (bypasses canary routing). |
| `content-type: application/json` | Required. |

**Response headers**

| Header | When set | Value |
|---|---|---|
| `x-manifest-variant` | Set on every chat call that resolves through the tenant Postgres layer | `stable` or `canary` — which side of an active canary rollout served the request. Absent when no canary is active or the manifest came from R2 / bundled. |

**Body**

```json
{
  "model": "quick",
  "messages": [{ "role": "user", "content": "What is 7 * 6?" }],
  "stream": false,
  "temperature": 0,
  "max_tokens": 1024
}
```

**Synchronous response**

```bash
curl -s -X POST $BASE_URL/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-thread-id: demo' \
  -d '{"model":"quick","messages":[{"role":"user","content":"hi"}]}' | jq
```

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1747100000,
  "model": "quick",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hi! How can I help?" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 412, "completion_tokens": 9, "total_tokens": 421 }
}
```

`usage` is the request's cumulative token count across every model call in the tool loop (from the same accumulator that enforces `max_input_tokens` / `max_output_tokens`). On streamed responses the final chunk (the one carrying `finish_reason`) includes the same `usage` object.

When the model emits tool calls on the final assistant message, they appear in OpenAI's `tool_calls` array and `finish_reason` is `tool_calls`:

```json
"message": {
  "role": "assistant",
  "content": "",
  "tool_calls": [
    { "id": "call_abc", "type": "function", "function": { "name": "calculator", "arguments": "{\"expression\":\"7*6\"}" } }
  ]
},
"finish_reason": "tool_calls"
```

**Streaming response**

Set `"stream": true`. Response is `text/event-stream`; each chunk is a JSON object on a `data:` line, and the stream terminates with `data: [DONE]\n\n`.

```bash
curl -N -X POST $BASE_URL/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"quick","stream":true,"messages":[{"role":"user","content":"Say hi"}]}'
```

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

**Errors**

| Status | Body | Cause |
|---|---|---|
| 400 | `{"error":{"message":"x-thread-id may not contain ':' or '#'"}}` | Malformed thread suffix. |
| 401 | `{"error":"unauthorized","manifest":"<name>"}` | Manifest disallows anonymous and no valid principal was presented. |
| 403 | `{"error":"forbidden","missing_scopes":["..."]}` | Required scopes from `auth.inbound.required_scopes` are missing. |
| 404 | `{"error":{"message":"Unknown model/manifest: foo"}}` | The `model` field is not a known manifest. |
| 429 | rate limited | Per-tenant sliding window exceeded. |
| 502 | `{"error":{"message":"agent invocation failed: ..."}}` | Upstream agent/model invocation failed (gateway error, model timeout, etc). Message truncated to 500 chars. |

---

## POST /chat

Felix-native synchronous chat. Same agent runtime as `/v1/chat/completions`, but the request and response shape are simpler.

**Body**

```json
{
  "manifest": "quick",
  "thread_id": "session-1",
  "messages": [{ "role": "user", "content": "hello" }]
}
```

**Response**

```json
{
  "messages": [...],
  "final": { "role": "assistant", "content": "Hello." },
  "thread_id": "session-1"
}
```

`messages` is the full transcript from this turn; `final` is the last assistant message.

If the agent throws (upstream gateway error, model timeout, binding outage), the route returns HTTP 502 with `{"error":"invocation_failed","detail":"<message>"}` rather than a bare 500. Malformed thread suffixes return HTTP 400 with `{"error":"invalid_thread_id","detail":"thread_id may not contain ':' or '#'"}`.

```bash
curl -s -X POST $BASE_URL/chat \
  -H 'content-type: application/json' \
  -d '{"manifest":"quick","messages":[{"role":"user","content":"hi"}]}' | jq
```

## POST /chat/stream

Felix-native SSE stream. Same body as `/chat`. Each event is one line of `data: {...JSON...}\n\n`; the stream ends with `data: [DONE]\n\n`. Events come straight from `agent.streamEvents()` and include `on_chat_model_stream`, `on_tool_start`, `on_tool_end`, `on_chain_end`. On invocation failure the server emits a final `{ event: 'on_error', data: { message } }` event before `[DONE]` so the client sees the cause rather than an abruptly-closed stream.

```bash
curl -N -X POST $BASE_URL/chat/stream \
  -H 'content-type: application/json' \
  -d '{"manifest":"quick","messages":[{"role":"user","content":"hi"}]}'
```

## GET /chat/history/:thread_id

Fetch the session event log for a thread. Requires an authenticated principal; returns 401 for anonymous callers. The `:thread_id` is a suffix; the server prefixes the tenant id before reading the `ConversationDO`.

```bash
curl -s -H "Authorization: Bearer $JWT" \
  $BASE_URL/chat/history/session-1 | jq
```

Returns `{ events: SessionEvent[], head: number }`, where each event carries `{ seq, ts, kind, role?, content?, tool_call_id?, name?, tool_calls?, metadata? }` and `head` is the next sequence number that would be assigned on append. Returns 400 if the suffix contains `:`/`#`.

## DELETE /chat/history/:thread_id

Reset a thread. Requires authentication.

```bash
curl -s -X DELETE -H "Authorization: Bearer $JWT" \
  $BASE_URL/chat/history/session-1
```

Returns `{ "ok": true }`.

---

## POST /a2a

Single JSON-RPC 2.0 endpoint that dispatches to one of five methods: `tasks/send`, `tasks/sendSubscribe`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`.

```
POST /a2a
content-type: application/json

{ "jsonrpc": "2.0", "id": <number|string>, "method": "<method>", "params": {...} }
```

The default manifest (`quick`) handles requests by default; supply `params.task.manifest` to dispatch a different one. `tasks/send` and `tasks/sendSubscribe` enforce the target manifest's inbound auth; all five methods are tenant-scoped through the `A2ATaskDO` key.

### tasks/send

Create a task, run the agent synchronously, return the result.

```bash
curl -s -X POST $BASE_URL/a2a \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tasks/send",
    "params": {
      "task": {
        "id": "task-001",
        "manifest": "quick",
        "input": { "messages": [{ "role": "user", "content": "ping" }] }
      }
    }
  }' | jq
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "task-001",
    "status": "completed",
    "output": { "messages": [...] },
    "continuation": null
  }
}
```

If `params.task.id` is omitted (or contains `:` / `#`), the server generates a fresh UUID. The task id becomes the conversation thread id (`${tenant}:a2a-<taskId>`), so a continuation task with the same id replays history.

### tasks/sendSubscribe

Same params as `tasks/send`, but the response is `text/event-stream`. The first event signals `in_progress`, intermediate events come from `agent.streamEvents()`, and the last event reports `completed`.

```bash
curl -N -X POST $BASE_URL/a2a \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0", "id": 2, "method": "tasks/sendSubscribe",
    "params": { "task": { "input": { "messages": [{"role":"user","content":"ping"}] } } }
  }'
```

### tasks/get

Fetch a task's current state from its `A2ATaskDO`. Tenant-scoped: a probe targeting another tenant's task returns `-32001 task not found`.

```bash
curl -s -X POST $BASE_URL/a2a \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tasks/get","params":{"id":"task-001"}}' | jq
```

### tasks/cancel

Mark a task cancelled.

```bash
curl -s -X POST $BASE_URL/a2a \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tasks/cancel","params":{"id":"task-001"}}' | jq
```

### tasks/resubscribe

Reattach to a previously-created task. Anthropic's Managed Agents framing of `wake(sessionId)` for the A2A surface: a client that lost its connection (network drop, browser refresh, worker eviction) calls `tasks/resubscribe` with the task id and gets the persisted session events replayed as SSE.

Response is `text/event-stream`. The first event is a preamble with the task status and wake summary:

```json
{ "id": "task-001", "status": "in_progress", "resumed_from_seq": 0, "head_seq": 4, "pending_tool_calls": 1 }
```

Subsequent events are `replay` rows, one per persisted session event the client missed:

```json
{ "event": "replay", "seq": 0, "message": { "role": "user", "content": "..." } }
{ "event": "replay", "seq": 1, "message": { "role": "assistant", "content": "...", "tool_calls": [...] } }
```

The final event depends on the task's status:

- **Terminal** (`completed` / `cancelled` / `failed`) — the stream emits the cached output and closes:
  ```json
  { "id": "task-001", "status": "completed", "output": { "messages": [...] }, "error": null }
  ```
- **Non-terminal** (`pending` / `in_progress`) — the stream emits a `continue_hint` and closes. Felix doesn't run agent work inside the resubscribe request itself; to continue from the resume point the client issues a fresh `tasks/sendSubscribe` with the same task id, and the session log carries the resume state:
  ```json
  { "id": "task-001", "status": "in_progress",
    "continue_hint": "issue tasks/sendSubscribe with the same task id to continue from the resume point" }
  ```

```bash
curl -N -X POST $BASE_URL/a2a \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tasks/resubscribe","params":{"id":"task-001"}}'
```

Tenant-scoped: a probe for another tenant's task id returns the same `task not found` error as a probe for a non-existent id.

**Error envelope**

```json
{ "jsonrpc": "2.0", "id": <id>, "error": { "code": -32601, "message": "unknown method ..." } }
```

| Code | Meaning |
|---|---|
| `-32000` | Generic server error (thrown exception). |
| `-32001` | Task not found (or not owned by the caller's tenant). |
| `-32601` | Unknown JSON-RPC method. |
| `-32602` | Invalid params (e.g. unknown manifest). |

---

## POST /mcp

Minimal MCP JSON-RPC server. The default manifest (`quick`) gates inbound auth; the manifest's tools, after governance wrapping, are what the MCP client sees.

### tools/list

```bash
curl -s -X POST $BASE_URL/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "calculator",
        "description": "Evaluate a basic arithmetic expression (...)",
        "inputSchema": { "type": "object", "properties": { "expression": { "type": "string" } }, "required": ["expression"] }
      }
    ]
  }
}
```

`inputSchema` is generated from each tool's Zod schema (via Zod v4's native `z.toJSONSchema`, target `draft-7`) in `src/patterns/zod-to-json-schema.ts`. Remote MCP tools whose `inputSchema` is already JSON Schema arrive with `rawInputSchema` set on the tool and that JSON Schema is forwarded verbatim, preserving any descriptions / enums the upstream server declared.

### tools/call

```bash
curl -s -X POST $BASE_URL/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
    "params": { "name": "calculator", "arguments": { "expression": "7*6" } }
  }' | jq
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": { "content": [{ "type": "text", "text": "42" }] }
}
```

Errors:

- `-32601 unknown method` — method other than `tools/list` / `tools/call`.
- `-32601 unknown tool: <name>` — the tool isn't exposed by the default manifest.
