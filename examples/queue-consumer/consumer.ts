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
  /**
   * Capability token authorizing the write-back for THIS job only — scoped to
   * its tenant, thread, and tool call, and expiring. Present it as
   * `x-consumer-token`; it is the intended credential, and using it means this
   * consumer never needs to hold the fleet-global secret at all.
   */
  callback_token?: string;
}

interface Env {
  /** Service binding pointing at the Felix Worker. */
  FELIX: Fetcher;
  /**
   * Fleet-global shared secret for the internal write-back route.
   *
   * Only needed for jobs enqueued before capability tokens existed, which
   * carry no `callback_token`. A deployment with no such jobs in flight can
   * leave this unset — that is the point of the token, since a consumer that
   * never holds this value cannot leak it.
   */
  CONSUMER_SHARED_SECRET?: string;
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
  // authenticates the caller and forwards to the ConversationDO. The exact
  // path is convention — pick whatever the Felix deployment exposes for
  // consumer write-backs.
  //
  // Prefer the per-job capability token: it authorizes exactly this tool call
  // on this thread and expires, so a leak from this consumer is worth one
  // already-known dispatch rather than the whole fleet's credential. The
  // shared secret is the fallback for jobs enqueued before tokens existed.
  // Note that when a token is sent it is authoritative — Felix will NOT fall
  // back to the secret if the token fails to verify.
  const auth: Record<string, string> = job.callback_token
    ? { 'x-consumer-token': job.callback_token }
    : env.CONSUMER_SHARED_SECRET
      ? { 'x-consumer-secret': env.CONSUMER_SHARED_SECRET }
      : {};
  if (Object.keys(auth).length === 0) {
    throw new Error(
      `job ${job.job_id} has no callback_token and CONSUMER_SHARED_SECRET is unset — cannot authenticate the write-back`,
    );
  }

  const resp = await env.FELIX.fetch(
    new Request(`https://felix/internal/sessions/${encodeURIComponent(job.thread_id)}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...auth,
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
