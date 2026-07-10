/**
 * Reference queue consumer for Felix's `queue` tool transport.
 *
 * Runs as a separate Worker, bound to the same Cloudflare Queue Felix's
 * `QueueExecutor` sends to. For each message, it:
 *
 *   1. Does the actual work (placeholder — replace with your own).
 *   2. POSTs a `kind: 'tool_result'` event back to Felix's
 *      `ConversationDO` keyed to the dispatching `tool_call_id`.
 *   3. ACKs the message; on any failure, it requeues via `message.retry()`
 *      so Cloudflare Queues redelivers later.
 *
 * The contract is narrow on purpose: queue message in → `tool_result`
 * event out. Anything else (idempotency, retries inside the work, audit
 * emission on the consumer side, etc.) is the consumer's concern.
 */

interface QueueJobMessage {
  job_id: string;
  thread_id: string;
  tool_call_id: string;
  tool: string;
  tenant_id: string;
  manifest_id: string;
  arguments: Record<string, unknown>;
  deadline_ms?: number;
}

interface Env {
  /** Service binding pointing at the Felix Worker. */
  FELIX: Fetcher;
  /** Shared secret on the internal write-back route — match it in Felix. */
  CONSUMER_SHARED_SECRET: string;
}

export default {
  async queue(batch: MessageBatch<QueueJobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const job = message.body;

        // 1. Deadline check — if the consumer is so backed up that the
        // job would land past its deadline, skip and let the orphan
        // cleanup write a synthetic [expired] tool_result.
        if (job.deadline_ms && Date.now() > job.deadline_ms) {
          message.ack();
          continue;
        }

        // 2. Do the work. Replace this stub with whatever the queued
        // tool is supposed to do — an LLM call, an external API, a
        // long compute, etc.
        const result = await doWork(job);

        // 3. Land the tool_result on Felix's ConversationDO.
        await writeResult(env, job, result);

        message.ack();
      } catch (err) {
        // Anything thrown → retry. Queues backs off and redelivers; the
        // consumer must be idempotent on job_id if writeResult succeeded
        // partway through. The simple approach: dedupe by querying
        // Felix's session for an existing tool_result before writing.
        console.error('queue consumer failed', message.body.job_id, err);
        message.retry();
      }
    }
  },
};

async function doWork(job: QueueJobMessage): Promise<string> {
  // Placeholder. The real consumer would dispatch by `job.tool` to a
  // handler that knows how to do that specific work.
  const args = JSON.stringify(job.arguments);
  return `[mock] ran ${job.tool} for tenant=${job.tenant_id} with args=${args}`;
}

async function writeResult(env: Env, job: QueueJobMessage, content: string): Promise<void> {
  // The Felix-side route this hits is a small internal endpoint that
  // verifies the shared secret and forwards to the ConversationDO. The
  // exact path is convention — pick whatever the Felix deployment
  // exposes for consumer write-backs.
  const resp = await env.FELIX.fetch(
    new Request(`https://felix/internal/sessions/${encodeURIComponent(job.thread_id)}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-consumer-secret': env.CONSUMER_SHARED_SECRET,
      },
      body: JSON.stringify({
        events: [
          {
            kind: 'tool_result',
            role: 'tool',
            tool_call_id: job.tool_call_id,
            name: job.tool,
            content,
            metadata: { job_id: job.job_id, source: 'queue-consumer' },
          },
        ],
      }),
    }),
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Felix rejected the write-back: ${resp.status} ${body.slice(0, 200)}`);
  }
}
