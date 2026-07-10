# Python sandbox — container-backed tool example

This is the end-to-end shape of a Felix manifest that exposes a sandboxed Python interpreter as a tool. It exists to make the container-transport plumbing concrete:

```
manifest (containers[]) ─► Felix builder ─► ContainerExecutor ─► gateway Worker ─► CF Container ─► output
```

The brain (model loop) sees a normal tool: `python_runner.invoke({ code: "..." })`. The harness routes the call through the declared gateway. The container is the only thing that ever sees the Python code, and it can crash, OOM, or time out without taking the Worker down.

## Files

- `manifest.yaml` — drop-in manifest. Declares one container-backed tool, `python_runner`, plus minimal model + system prompt.
- `mock-gateway.ts` — ~40-line gateway Worker that fakes the protocol. Use this to exercise the manifest locally without a real container.
- `runtime/Dockerfile` — what a real container image would look like. A 25-line Python evaluator that reads JSON from stdin and writes JSON to stdout.

## Run it locally (mock gateway)

```bash
# Terminal A — start the mock gateway on :8788
cd examples/python-sandbox
pnpm dlx wrangler dev mock-gateway.ts --port 8788

# Terminal B — install this manifest into Felix and call the agent
pnpm dev
# in another shell:
curl -s http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -d '{ "manifest": "python-sandbox-demo", "messages": [{ "role": "user", "content": "what is 2+2 in python?" }] }'
```

The manifest ships with a placeholder `gateway_url` (`https://sandbox.example.com/run`) — **edit `manifest.yaml` to point it at `http://localhost:8788/run` first**, then re-run `pnpm build:manifests`. The mock Worker echoes the `code` field back as the "output" so you can see the round-trip without standing up a container.

## Going from mock to a real Cloudflare Container

The mock gateway is a literal stand-in. When CF Containers GA, swap it out:

1. Build `runtime/Dockerfile` and push to a registry.
2. Register the binding in `wrangler.jsonc`:
   ```jsonc
   "containers": [
     {
       "name": "PYTHON_SANDBOX",
       "image": "ghcr.io/yourorg/python-sandbox:latest",
       "instance_type": "standard"
     }
   ]
   ```
3. Replace `mock-gateway.ts` with a real gateway that translates `POST { image, tool, arguments }` into `getContainer(env.PYTHON_SANDBOX).fetch(...)`. The gateway is the trust boundary — it decides which images the caller is allowed to invoke and adds any per-image secrets.
4. Update `manifest.yaml`'s `gateway_url` to point at the deployed gateway.

Nothing in Felix's manifest, executor, or audit changes between the mock and the real gateway. That's the point of the transport seam.

## Gateway protocol

The contract is intentionally narrow so any HTTPS endpoint can serve it:

```
POST {gateway_url}
{ "image": "<image>", "tool": "<tool>", "arguments": { ... } }

200 { "content": "...", "exit_code"?: number, "stderr"?: string }
non-2xx       → executor returns "[container error] <image>: <status> <body>"
exit_code N≠0 → executor returns "[container exit N] <tool>: <stderr|content>"
```

Cancellation: the gateway request honors the caller's `AbortSignal` and the manifest's `timeout_ms`. Either firing aborts the in-flight fetch.

Credentials: Felix attaches an `Authorization` header to the gateway request when `containers[].auth` is set; the value comes from `AuthContext.outboundToken({ name, auth, url })`. The header never enters `arguments`, so the container never sees the credential.
