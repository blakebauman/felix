/**
 * Worker entry — exports the fetch handler + scheduled handler + every
 * Durable Object class. Single import surface for the runtime.
 *
 * `compose(env)` runs once per isolate (the result is cached on the
 * module-scope `provider` lazily). Hono receives `Bindings: Env` so
 * downstream handlers read bindings off `c.env` rather than module
 * globals.
 */

import { createApp } from './app';
import type { AuditEvent } from './audit/models';
import { persistBatch } from './audit/store';
import { compose, installedPlugins } from './composition';
import { buildAnonymousContext, disposeLimitState, runWithContext } from './context';
import type { Env } from './env';
import { runAnomalyScan } from './jobs/anomaly-detector';
import { parseContinuousEvalOpts, runContinuousEvalTick } from './jobs/continuous-eval';
import { runScheduledJobs } from './jobs/cron';
import { sweepOrphanQueueDispatches } from './jobs/queue-orphan-cleanup';
import type { FelixPlugin } from './plugins/types';
import { federationStub } from './policy/federation-do';

export { A2ATaskDO } from './a2a/task-do';
export { ApprovalsDO } from './approvals/approvals-do';
export { ConversationDO } from './memory/conversation-do';
export { FederationDO } from './policy/federation-do';
export { AgentWorkflow } from './workflows/agent-workflow';

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
          }
          try {
            await runScheduledJobs(env);
          } catch (err) {
            console.error('scheduled jobs run failed', err);
          }
          try {
            await sweepOrphanQueueDispatches(env);
          } catch (err) {
            console.error('queue orphan cleanup failed', err);
          }
          try {
            await runAnomalyScan(env);
          } catch (err) {
            console.error('anomaly scan failed', err);
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
              }
            }
          }
        } finally {
          disposeLimitState(reqCtx.limitState);
        }
      }),
    );
  },

  async queue(batch: MessageBatch<AuditEvent>, env: Env): Promise<void> {
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
  },
} satisfies ExportedHandler<Env, AuditEvent>;
