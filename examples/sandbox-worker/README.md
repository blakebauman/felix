# Sandbox adapter — wiring `@cloudflare/sandbox` to Felix's `sandbox` transport

This is the reference Worker that bridges Felix's `SandboxExecutor` (`transport: 'sandbox'`, sixth tool transport) to the official [`@cloudflare/sandbox`](https://www.npmjs.com/package/@cloudflare/sandbox) SDK. Deploy it as a separate Worker, bind it into Felix as a Service binding, and any manifest declaring `spec.sandboxes[]` will route through it.

```
Felix manifest                    this Worker                       Cloudflare
(spec.sandboxes[])  ──Service──►  POST /exec  ──@cloudflare/sandbox──►  Container
                     binding       { tool,                              (per-session DO)
                                     arguments,
                                     session,
                                     timeout_ms }
```

The brain (model loop) sees a normal tool: `code_exec({ code: "print(2+2)", language: "python" })`. Felix routes the call through `SandboxExecutor`, which POSTs `/exec` to this Worker. This Worker dispatches to the right Sandbox SDK primitive and returns `{ content, exit_code?, stderr? }` — same shape `ContainerExecutor` already expects.

## Files

- `adapter.ts` — ~120 lines. One `fetch()` handler, one dispatch switch covering `code_exec`, `fs_read`, `fs_write`, `fs_list`, and a generic `shell`.
- `wrangler.example.jsonc` — Container + Durable Object + Sandbox class bindings.

## Wiring

```jsonc
// 1. This Worker (adapter.ts): see wrangler.example.jsonc
//    Re-exports the `Sandbox` DO class from @cloudflare/sandbox.

// 2. Felix's wrangler.jsonc — bind this Worker as a Service binding
"services": [{ "binding": "SANDBOX", "service": "felix-sandbox-worker" }],
```

```yaml
# 3. Felix manifest — declare the sandbox tools the model should see
spec:
  sandboxes:
    - name: code_exec
      binding: SANDBOX               # matches the Service binding name above
      sandbox_tool_name: code_exec   # what this Worker routes on
      timeout_ms: 30000
    - name: fs_write
      binding: SANDBOX
      sandbox_tool_name: fs_write
    - name: fs_read
      binding: SANDBOX
      sandbox_tool_name: fs_read
```

Felix's builder (`src/manifests/builder.ts`) resolves each `binding: SANDBOX` to `env.SANDBOX` and wraps the executor through the existing governance pipeline (policies → limits → guardrails → judges → approvals). Audit rows land with `transport: 'sandbox'`.

## Sessions

Felix passes the request's `threadId` through as the `session` field on every `/exec` call. This Worker keys each Sandbox DO by `session`, so:

- A multi-turn conversation in the same thread sees the same filesystem state — `fs_write` followed by `fs_read` works as expected.
- Two different threads (even in the same tenant) get isolated sandboxes.
- An anonymous `/v1/chat/completions` request without `x-thread-id` lands on a shared `default` session — be careful, and prefer threading the session id explicitly.

## Failure modes

1. **Sandbox cold start** — the Container DO takes a few hundred ms to spin up on first use. Felix's `timeout_ms` covers this.
2. **Exit code != 0** — surfaced as `{ exit_code: N, stderr }`; Felix's `SandboxExecutor` translates this into a `[sandbox exit N]` ToolOutput tagged `provider_error` and the model gets to recover.
3. **Thrown exception inside this Worker** — returned as HTTP 500 with `{ stderr, exit_code: 1 }`; Felix's `codeForStatus` maps that to `provider_error`.
4. **Unknown tool name** — returned as `{ exit_code: 1, stderr: "unknown sandbox tool: …" }` so the model sees the mistake immediately.

## Run it locally

```bash
cd examples/sandbox-worker
pnpm dlx wrangler dev adapter.ts --port 8788
```

Then in another shell:

```bash
curl -s http://localhost:8788/exec \
  -H 'content-type: application/json' \
  -d '{
    "tool": "code_exec",
    "arguments": { "code": "print(2+2)", "language": "python" },
    "session": "demo:thread-1"
  }'
# → {"content":"4\n","stderr":"","exit_code":0}
```

## Why a separate Worker (not inline)

Same reason `examples/queue-consumer/` is a separate Worker: brain/hands decoupling. The Sandbox SDK's container lifecycle, image build pipeline, and per-DO storage are deployment concerns that should fail independently of the orchestrator. Felix sees `env.SANDBOX` as a generic `Fetcher` — swap this adapter for any other sandbox provider that speaks the same `{tool, arguments, session?}` protocol and the manifest doesn't need to change.
