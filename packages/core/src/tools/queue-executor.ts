/**
 * QueueExecutor — brain-hands transport for long-running, asynchronous
 * tool work. Anthropic's Managed Agents framing applied: the model loop
 * calls `execute(name, input)`; the executor enqueues a job and returns
 * a pending stub. A separate consumer processes the job and writes its
 * result back to the session as a `tool_result` event on the original
 * `tool_call_id`. When the client resubscribes (`tasks/resubscribe`),
 * `session.wake()` sees the now-resolved cycle and the next model step
 * picks up the result naturally.
 *
 * This executor is the *enqueue* half of that protocol. The *consume*
 * half lives outside Felix (a separate Worker / Container / queue
 * consumer), so the transport is genuinely decoupled — the harness only
 * needs to know where to drop the job. The consumer writes its
 * `tool_result` via the same `ConversationDO` write path patterns use.
 *
 * The shape of the queue message:
 *
 *   {
 *     "thread_id":    "<tenant:thread>",
 *     "tool_call_id": "<id from the assistant turn>",
 *     "tool":         "<tool name as seen by the model>",
 *     "tenant_id":    "<auth.principal.tenantId>",
 *     "manifest_id":  "<manifest.metadata.name>",
 *     "arguments":    { ... validated tool inputs },
 *     "deadline_ms":  <epoch ms when the consumer should give up>?
 *   }
 *
 * Stub returned to the model:
 *
 *   `[queued] tool '<name>' is running asynchronously (job_id=<id>). ` +
 *   `Tell the user the result will arrive on the next turn; they can ` +
 *   `reconnect with tasks/resubscribe to wait for it.`
 *
 * The stub is intentionally chatty so the model has enough context to
 * respond well to the user without further tool calls.
 */

import { z } from 'zod';
import { recordEvent } from '../audit/store';
import { getContext } from '../context';
import type { Env } from '../env';
import { toolErrorOutput } from './errors';
import type { ToolExecutor } from './executor';
import {
  defineToolWithExecutor,
  type Tool,
  type ToolInput,
  type ToolInvocationCtx,
  type ToolOutput,
} from './types';

export interface QueueExecutorOpts {
  /** Cloudflare Queues binding the job is sent to. */
  queue: Queue;
  /** Manifest id, written into the queue message so consumers can route. */
  manifestId: string;
  /** Optional deadline (relative ms) the consumer should honor. */
  deadlineMs?: number;
  /**
   * Optional job-id generator. Default: `crypto.randomUUID()`. Override
   * for tests or to thread a tenant-prefixed id scheme.
   */
  newJobId?: () => string;
}

export interface QueueJobMessage {
  job_id: string;
  thread_id: string;
  tool_call_id: string;
  tool: string;
  tenant_id: string;
  manifest_id: string;
  arguments: Record<string, unknown>;
  deadline_ms?: number;
}

export class QueueExecutor implements ToolExecutor {
  readonly transport = 'queue';
  constructor(
    private readonly toolName: string,
    private readonly opts: QueueExecutorOpts,
  ) {}

  async execute(args: ToolInput, ctx?: ToolInvocationCtx): Promise<ToolOutput> {
    const requestCtx = getContext();
    const tenantId = requestCtx?.auth.principal.tenantId ?? 'default';
    // Prefer the pattern-supplied threadId on the ToolInvocationCtx —
    // it's pattern-scoped, so a router-forwarded child reports the
    // parent's threadId while a parallel child (which strips it)
    // correctly reports none, and the enqueue refuses below.
    const threadId = ctx?.threadId ?? requestCtx?.threadId ?? '';
    const toolCallId = ctx?.toolCallId ?? '';
    const newId = this.opts.newJobId ?? (() => crypto.randomUUID());
    const jobId = newId();
    if (!toolCallId) {
      // Without a tool_call_id the consumer can't write a result back to
      // the session that matches an assistant turn — the resume cycle
      // would never complete. Better to fail loudly here than to enqueue
      // a job that can never be resolved.
      return toolErrorOutput(
        'internal',
        `[queue error] tool '${this.toolName}' has no tool_call_id in ctx — async dispatch needs a paired assistant tool call.`,
      );
    }
    if (!threadId) {
      // No threadId means the consumer wouldn't know which session to
      // write the result back to. This happens cleanly for queue tools
      // dispatched under `pattern: parallel` (which strips threadId from
      // its children) and for stateless `/v1/chat/completions` requests
      // without an `x-thread-id` header. Refusing here surfaces the
      // misconfiguration to the model immediately instead of silently
      // dropping work on the floor.
      return toolErrorOutput(
        'internal',
        `[queue error] tool '${this.toolName}' has no thread_id — async dispatch needs a persistent session (set thread_id on the request, or move the tool to a pattern that preserves it).`,
      );
    }

    const message: QueueJobMessage = {
      job_id: jobId,
      thread_id: threadId,
      tool_call_id: toolCallId,
      tool: this.toolName,
      tenant_id: tenantId,
      manifest_id: this.opts.manifestId,
      arguments: args,
      ...(this.opts.deadlineMs ? { deadline_ms: Date.now() + this.opts.deadlineMs } : {}),
    };

    try {
      await this.opts.queue.send(message);
    } catch (err) {
      // Enqueue failure is recoverable — the model sees the error string
      // and can decide whether to retry. Audit + counters fire upstream
      // in the react loop's tool_call branch.
      return toolErrorOutput(
        'transport_unavailable',
        `[queue error] failed to enqueue tool '${this.toolName}': ${(err as Error).message}`,
      );
    }

    // Emit a `queue_dispatch` audit so a tenant timeline shows when the
    // job was enqueued. The eventual `queue_complete` (written by the
    // consumer) pairs to this row by `job_id`; the orphan-cleanup cron
    // reads pairs to find unresolved dispatches.
    recordEvent({
      tenantId,
      eventType: 'queue_dispatch',
      principalSubject: requestCtx?.auth.principal.subject ?? '',
      manifestId: this.opts.manifestId,
      status: 'enqueued',
      payload: {
        job_id: jobId,
        tool: this.toolName,
        tool_call_id: toolCallId,
        thread_id: threadId,
        ...(message.deadline_ms ? { deadline_ms: message.deadline_ms } : {}),
      },
    });

    return (
      `[queued] tool '${this.toolName}' is running asynchronously (job_id=${jobId}). ` +
      'Tell the user the result will arrive on the next turn; they can ' +
      'reconnect with tasks/resubscribe to wait for it.'
    );
  }
}

/**
 * Build a `Tool` whose executor is a `QueueExecutor`. Pairs the inward
 * Zod schema (which validates the model's input before enqueueing) with
 * the queue-bound executor.
 *
 * The consumer side is intentionally out of scope here — it lives in a
 * separate Worker (or queue consumer in `index.ts:queue`) that pulls
 * messages, runs the actual work, and writes a `tool_result` event back
 * to `ConversationDO` keyed by `thread_id`. `session.wake()` and
 * `tasks/resubscribe` handle the resume side: a client reconnecting
 * after the consumer has landed the result sees a resolved cycle and
 * the next model step picks it up naturally.
 */
export function queueTool<S extends z.ZodTypeAny>(spec: {
  name: string;
  description: string;
  args: S;
  rawInputSchema?: Record<string, unknown>;
  fatal?: boolean;
  queue: Queue;
  manifestId: string;
  deadlineMs?: number;
  newJobId?: () => string;
}): Tool {
  return defineToolWithExecutor({
    name: spec.name,
    description: spec.description,
    args: spec.args,
    rawInputSchema: spec.rawInputSchema,
    fatal: spec.fatal,
    source: `queue:${spec.name}`,
    executor: new QueueExecutor(spec.name, {
      queue: spec.queue,
      manifestId: spec.manifestId,
      deadlineMs: spec.deadlineMs,
      newJobId: spec.newJobId,
    }),
  });
}

/**
 * Shape of a manifest `queues[]` entry (kept local so this module doesn't
 * import the full Zod manifest schema). The builder hands us a record
 * that already passed schema validation; we just have to resolve the
 * binding and wire the executor.
 */
export interface QueueRefLike {
  name: string;
  description?: string;
  queue_binding: string;
  deadline_ms?: number | null;
  args_schema?: Record<string, unknown> | null;
  fatal?: boolean;
}

/**
 * Build a queue-backed `Tool` from a manifest `queues[]` entry. The
 * binding is resolved against `env[ref.queue_binding]` at build time;
 * a missing binding throws so a misconfigured manifest never silently
 * no-ops at request time.
 *
 * The inward Zod schema stays permissive (`record(unknown)`) because
 * the consumer owns input validation; when the manifest declares
 * `args_schema`, it is advertised to the model verbatim through
 * `rawInputSchema`.
 */
export function makeQueueTool(ref: QueueRefLike, env: Env, manifestId: string): Tool {
  const binding = (env as unknown as Record<string, Queue | undefined>)[ref.queue_binding];
  if (!binding || typeof binding.send !== 'function') {
    throw new Error(
      `queue tool '${ref.name}' references binding '${ref.queue_binding}' which is not configured on env — add a Queues producer with that name to wrangler.jsonc.`,
    );
  }
  return queueTool({
    name: ref.name,
    description: ref.description ?? '',
    args: z.record(z.string(), z.unknown()),
    rawInputSchema: ref.args_schema ?? undefined,
    fatal: ref.fatal ?? false,
    queue: binding,
    manifestId,
    deadlineMs: ref.deadline_ms ?? undefined,
  });
}
