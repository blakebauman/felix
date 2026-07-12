/**
 * Worker entry — exports the fetch handler + scheduled handler + every
 * Durable Object class. Single import surface for the runtime.
 *
 * `compose(env)` runs once per isolate (the result is cached on the
 * module-scope `provider` lazily). Hono receives `Bindings: Env` so
 * downstream handlers read bindings off `c.env` rather than module
 * globals.
 */

import { createApp } from '@felix/harness/app';
import type { AuditEvent } from '@felix/harness/audit/models';
import { persistBatch } from '@felix/harness/audit/store';
import {
  buildAnonymousContext,
  disposeContextDb,
  disposeLimitState,
  runWithContext,
} from '@felix/harness/context';
import type { Env } from '@felix/harness/env';
import { runAnomalyScan } from '@felix/harness/jobs/anomaly-detector';
import { drainAuditDlq } from '@felix/harness/jobs/audit-dlq';
import {
  parseContinuousEvalOpts,
  runContinuousEvalTick,
} from '@felix/harness/jobs/continuous-eval';
import { runScheduledJobs } from '@felix/harness/jobs/cron';
import { sweepOrphanQueueDispatches } from '@felix/harness/jobs/queue-orphan-cleanup';
import { runRetentionSweep } from '@felix/harness/jobs/retention';
import { recordCounter } from '@felix/harness/observability/metrics';
import type { FelixPlugin } from '@felix/harness/plugins/types';
import { federationStub } from '@felix/harness/policy/federation-do';
import { compose, installedPlugins } from './composition';

export { A2ATaskDO } from '@felix/harness/a2a/task-do';
export { ApprovalsDO } from '@felix/harness/approvals/approvals-do';
export { ConversationDO } from '@felix/harness/memory/conversation-do';
export { FederationDO } from '@felix/harness/policy/federation-do';
export { AgentWorkflow } from './agent-workflow';

let cachedApp: ReturnType<typeof createApp> | null = null;
let cachedTools: ReturnType<typeof compose> | null = null;
let cachedPlugins: FelixPlugin[] | null = null;

function toolsFor(env: Env): ReturnType<typeof compose> {
  if (!cachedTools) cachedTools = compose(env);
  return cachedTools;
}

function pluginsInstalled(): FelixPlugin[] {
  if (!cachedPlugins) cachedPlugins = installedPlugins();
  return cachedPlugins;
}

function appFor(env: Env): ReturnType<typeof createApp> {
  if (!cachedApp) {
    cachedApp = createApp({
      tools: toolsFor(env),
      defaultManifest: 'quick',
      plugins: pluginsInstalled(),
    });
  }
  return cachedApp;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return appFor(env).fetch(req, env, ctx);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cron runs outside the auth middleware, so install a fresh anonymous
    // RequestContext here. Without it, recordEvent falls back to console.log
    // instead of enqueueing audit events, and any future agent invocation
    // from within runScheduledJobs would be missing its LimitState.
    const reqCtx = buildAnonymousContext(env, ctx);
    ctx.waitUntil(
      runWithContext(reqCtx, async () => {
        try {
          try {
            await federationStub(env).fetch('https://do/refresh');
          } catch (err) {
            console.error('federation refresh failed', err);
            recordCounter('orchestrator_cron_task_failures', { task: 'federation_refresh' });
          }
          try {
            await runScheduledJobs(env);
          } catch (err) {
            console.error('scheduled jobs run failed', err);
            recordCounter('orchestrator_cron_task_failures', { task: 'scheduled_jobs' });
          }
          try {
            await sweepOrphanQueueDispatches(env);
          } catch (err) {
            console.error('queue orphan cleanup failed', err);
            recordCounter('orchestrator_cron_task_failures', { task: 'queue_orphan_cleanup' });
          }
          try {
            await runAnomalyScan(env);
          } catch (err) {
            console.error('anomaly scan failed', err);
            recordCounter('orchestrator_cron_task_failures', { task: 'anomaly_scan' });
          }
          try {
            // Retention / GC: prune audit_events past the retention window
            // and expired plans, bounded per tick.
            await runRetentionSweep(env, Date.now(), ctx);
          } catch (err) {
            console.error('retention sweep failed', err);
          }
          try {
            // Online benchmarking: replay sampled production inputs
            // through each in-flight canary and judge the result. No-op
            // when no canaries are live.
            await runContinuousEvalTick(
              env,
              toolsFor(env),
              parseContinuousEvalOpts(env),
              Date.now(),
              ctx,
            );
          } catch (err) {
            console.error('continuous eval tick failed', err);
            recordCounter('orchestrator_cron_task_failures', { task: 'continuous_eval' });
          }
          // Feature-plugin cron tasks (e.g. commerce abandoned-cart scan,
          // GEO monitor). Each task is isolated so one failing plugin task
          // never starves core crons or other plugins.
          for (const plugin of pluginsInstalled()) {
            for (const task of plugin.cronTasks ?? []) {
              try {
                await task.run({ env, tools: toolsFor(env), now: Date.now(), execCtx: ctx });
              } catch (err) {
                console.error(`${plugin.name} cron task ${task.name} failed`, err);
                recordCounter('orchestrator_cron_task_failures', {
                  task: `${plugin.name}:${task.name}`,
                });
              }
            }
          }
        } finally {
          disposeLimitState(reqCtx.limitState);
          disposeContextDb(reqCtx);
        }
      }),
    );
  },

  async queue(batch: MessageBatch<AuditEvent>, env: Env, ctx: ExecutionContext): Promise<void> {
    // Runs under an anonymous RequestContext (like `scheduled`) so `getDb`
    // caches one Postgres client per batch instead of opening a connection
    // per store call.
    const reqCtx = buildAnonymousContext(env, ctx);
    try {
      await runWithContext(reqCtx, async () => {
        // Dead-letter branch: the `felix-audit-dlq-*` queues collect audit
        // events the main consumer exhausted its retries on. Drain them
        // best-effort (log + counter + direct write) and ACK unconditionally
        // — a DLQ has no further dead-letter, so retrying would only loop.
        if (batch.queue.includes('-dlq')) {
          try {
            await drainAuditDlq(
              env,
              batch.messages.map((m) => m.body),
            );
          } catch (err) {
            console.error('audit DLQ drain failed', err);
            recordCounter('orchestrator_cron_task_failures', { task: 'audit_dlq_drain' });
          }
          for (const m of batch.messages) m.ack();
          return;
        }
        if (batch.queue !== 'felix-audit') return;
        // Fast path: try the batched insert. On whole-batch failure, fall back
        // to per-row inserts so we can ack successes and retry only the failures
        // — otherwise one poison row blocks the queue and starves audit writes
        // for every tenant.
        try {
          await persistBatch(
            env,
            batch.messages.map((m) => m.body),
          );
          for (const m of batch.messages) m.ack();
          return;
        } catch (err) {
          console.error('audit batch persist failed, falling back to per-row', err);
        }
        for (const m of batch.messages) {
          try {
            await persistBatch(env, [m.body]);
            m.ack();
          } catch (rowErr) {
            console.error('audit row persist failed', rowErr);
            m.retry({ delaySeconds: 30 });
          }
        }
      });
    } finally {
      disposeLimitState(reqCtx.limitState);
      disposeContextDb(reqCtx);
    }
  },
} satisfies ExportedHandler<Env, AuditEvent>;
