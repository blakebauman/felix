# Queue consumer — closing the async-tool loop

This is the consumer side of Felix's `queue` transport. It's deliberately a separate Worker so the dispatch path (Felix) and the work path (this consumer) can scale and fail independently — that's the whole point of the transport seam from the [Managed Agents](https://www.anthropic.com/engineering/managed-agents) article.

Felix dispatches a job by:

```
QueueExecutor.execute({ payload }, { toolCallId: 'tc1' })
  ↓
queue.send({ job_id, thread_id, tool_call_id, tool, tenant_id, manifest_id, arguments, deadline_ms? })
  ↓
returns "[queued] tool 'long_research' is running asynchronously (job_id=…)" to the model
```

This consumer:

```
queue() → for each message:
  • do the work (LLM call, external API, long compute, …)
  • POST to the dispatching Felix Worker's ConversationDO at
      /events with a `kind: 'tool_result'` event keyed to tool_call_id
  • emit `queue_complete` audit row (optional but recommended)
```

When the user reconnects via `tasks/resubscribe`, `session.wake()` reports the cycle resolved and the next model step renders the new `tool_result` through the strategy.

## Wiring

Both Workers bind the **same Cloudflare Queue**:

```jsonc
// Felix Worker (producer)
"queues": {
  "producers": [{ "binding": "JOBS_QUEUE", "queue": "felix-jobs" }]
}

// This Worker (consumer)
"queues": {
  "consumers": [
    { "queue": "felix-jobs", "max_batch_size": 10, "max_batch_timeout": 5 }
  ]
}
```

This Worker also needs a way to reach the Felix `ConversationDO` to land the `tool_result`. The recommended shape is a service binding (no auth dance, no public surface required):

```jsonc
"services": [{ "binding": "FELIX", "service": "felix-orchestrator" }]
```

Then write back via a dedicated route on the Felix worker — `consumer.ts` posts to `${FELIX_BASE}/internal/sessions/{thread_id}/events` (`src/api/internal.ts`), which the Felix side authenticates via the `x-consumer-secret` shared-secret header (`CONSUMER_SHARED_SECRET` set on both Workers).

## Files

- `consumer.ts` — the Worker entrypoint. ~60 lines: one `queue()` handler, one helper that POSTs back to Felix.
- `wrangler.example.jsonc` — what `wrangler.jsonc` would look like for this Worker.

## Failure modes

1. **Consumer crashes mid-job** — Cloudflare Queues redelivers the message; the consumer must be idempotent on `job_id` (e.g., dedupe before writing the `tool_result`).
2. **Felix is unreachable when the consumer tries to write back** — the consumer returns the message to the queue (`message.retry()`) so it'll be redelivered.
3. **`deadline_ms` passed** — the consumer emits `queue_expired` and does **not** write a `tool_result`. The Felix-side orphan-cleanup cron ([`src/jobs/queue-orphan-cleanup.ts`](../../src/jobs/queue-orphan-cleanup.ts)) writes a synthetic `[expired]` `tool_result` so the cycle resolves and the model can apologize to the user.
4. **Bad payload (no `tool_call_id`)** — Felix's `QueueExecutor` refuses to enqueue jobs without a `tool_call_id`, so the consumer can trust the field is always set.

The contract is intentionally narrow: queue message in, `tool_result` event out, both keyed by `tool_call_id`. Anything else is the consumer's concern.
