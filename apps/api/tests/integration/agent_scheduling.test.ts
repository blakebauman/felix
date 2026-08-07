/**
 * Agent-facing scheduling tools, against real Postgres.
 *
 * Scheduling is a privilege, not a convenience: what gets created here runs
 * unattended on the cron sweep, as some manifest, indefinitely. So the guards
 * carry most of the weight — the manifest is pinned to the caller's own, the
 * frequency has a floor, and the tenant has a cap — and each is asserted
 * directly rather than trusted.
 */

import { env } from 'cloudflare:test';
import {
  disposeContextDb,
  newLimitState,
  type RequestContext,
  runWithContext,
} from '@felix/harness/context';
import type { Env as AppEnv } from '@felix/harness/env';
import { buildSchedulingTools, scheduleIntervalMinutes } from '@felix/harness/jobs/agent-tools';
import { getJob, listJobs } from '@felix/harness/jobs/store';
import type { Tool, ToolOutput } from '@felix/harness/tools/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { withPgContext } from './setup';

const testEnv = env as unknown as AppEnv;

const tools = new Map<string, Tool>(buildSchedulingTools().map((t) => [t.name, t]));

function content(out: ToolOutput): string {
  return typeof out === 'string' ? out : out.content;
}

/** Invoke a scheduling tool as `tenant` running manifest `manifestId`. */
async function call(
  name: string,
  args: Record<string, unknown>,
  tenant: string,
  manifestId = 'caller-agent',
): Promise<string> {
  const ctx: RequestContext = {
    env: testEnv,
    auth: {
      principal: { subject: 'agent', tenantId: tenant, scopes: [], issuer: 'test' },
      outboundToken: async () => '',
    },
    limitState: newLimitState(),
    manifestId,
  };
  try {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return content(await runWithContext(ctx, () => tool.executor.execute(args, { manifestId })));
  } finally {
    disposeContextDb(ctx);
  }
}

async function clearJobs(tenant: string): Promise<void> {
  await withPgContext(testEnv, async () => {
    for (const job of await listJobs(testEnv, tenant)) {
      const { deleteJob } = await import('@felix/harness/jobs/store');
      await deleteJob(testEnv, tenant, job.name);
    }
  });
}

describe('scheduleIntervalMinutes', () => {
  it('measures the gap between the next two firings', () => {
    const from = new Date(Date.UTC(2026, 7, 7, 0, 0, 0));
    expect(scheduleIntervalMinutes('*/30 * * * *', from)).toBe(30);
    expect(scheduleIntervalMinutes('0 * * * *', from)).toBe(60);
    expect(scheduleIntervalMinutes('0 9 * * *', from)).toBe(1440);
  });

  it('returns null for an expression that never fires twice', () => {
    expect(scheduleIntervalMinutes('nonsense', new Date())).toBeNull();
  });
});

describe('schedule_task', () => {
  const tenant = 'sched-create';
  beforeEach(() => clearJobs(tenant));

  it('creates a task pinned to the calling manifest', async () => {
    const out = await call(
      'schedule_task',
      { name: 'digest', schedule: '0 9 * * *', input: 'Summarize yesterday.' },
      tenant,
      'my-agent',
    );
    expect(out).toContain('Scheduled');

    const job = await withPgContext(testEnv, () => getJob(testEnv, tenant, 'digest'));
    // Pinned, not taken from arguments — otherwise an agent could schedule
    // work as a manifest with a wider tool set.
    expect(job?.manifest_id).toBe('my-agent');
    expect(job?.enabled).toBe(true);
    expect(job?.payload).toEqual({ input: 'Summarize yesterday.' });
    expect(job?.next_run_at).not.toBeNull();
  });

  it('ignores any manifest the caller tries to supply', async () => {
    await call(
      'schedule_task',
      {
        name: 'sneaky',
        schedule: '0 9 * * *',
        input: 'go',
        manifest_id: 'privileged-agent',
      },
      tenant,
      'my-agent',
    );
    const job = await withPgContext(testEnv, () => getJob(testEnv, tenant, 'sneaky'));
    // The arg is not in the schema, so it is rejected outright — but assert the
    // stored manifest regardless, since this is the escalation that matters.
    expect(job?.manifest_id ?? 'my-agent').toBe('my-agent');
  });

  it('refuses a schedule that fires more often than the floor', async () => {
    const out = await call(
      'schedule_task',
      { name: 'toofast', schedule: '* * * * *', input: 'go' },
      tenant,
    );
    expect(out).toContain('too frequent');
    expect(await withPgContext(testEnv, () => getJob(testEnv, tenant, 'toofast'))).toBeNull();
  });

  it('refuses a malformed schedule', async () => {
    const out = await call(
      'schedule_task',
      { name: 'bad', schedule: 'every tuesday', input: 'go' },
      tenant,
    );
    expect(out).toContain('invalid schedule');
  });

  it('refuses an empty instruction', async () => {
    // A run has no other context, so an empty input is a task that can never
    // do anything.
    const out = await call(
      'schedule_task',
      { name: 'empty', schedule: '0 9 * * *', input: '   ' },
      tenant,
    );
    expect(out).toContain('invalid input');
  });

  it('refuses a name that could escape its key space', async () => {
    const out = await call(
      'schedule_task',
      { name: 'bad/name', schedule: '0 9 * * *', input: 'go' },
      tenant,
    );
    expect(out).toContain('invalid name');
  });

  it('replaces an existing task of the same name', async () => {
    await call('schedule_task', { name: 'dup', schedule: '0 9 * * *', input: 'first' }, tenant);
    const out = await call(
      'schedule_task',
      { name: 'dup', schedule: '0 10 * * *', input: 'second' },
      tenant,
    );
    expect(out).toContain('Replaced');
    const job = await withPgContext(testEnv, () => getJob(testEnv, tenant, 'dup'));
    expect(job?.schedule).toBe('0 10 * * *');
    expect(job?.payload).toEqual({ input: 'second' });
  });
});

describe('per-tenant cap', () => {
  const tenant = 'sched-cap';
  beforeEach(() => clearJobs(tenant));

  it('stops a loop from filling the table', async () => {
    for (let i = 0; i < 25; i++) {
      await call('schedule_task', { name: `t${i}`, schedule: '0 9 * * *', input: 'go' }, tenant);
    }
    const out = await call(
      'schedule_task',
      { name: 'one-too-many', schedule: '0 9 * * *', input: 'go' },
      tenant,
    );
    expect(out).toContain('limit reached');
  });

  it('still allows replacing an existing task at the cap', async () => {
    for (let i = 0; i < 25; i++) {
      await call('schedule_task', { name: `r${i}`, schedule: '0 9 * * *', input: 'go' }, tenant);
    }
    // Replacement adds no row, so the cap must not block fixing a task.
    const out = await call(
      'schedule_task',
      { name: 'r0', schedule: '0 11 * * *', input: 'revised' },
      tenant,
    );
    expect(out).toContain('Replaced');
  });
});

describe('tenant isolation', () => {
  it('never shows or cancels another tenant task', async () => {
    await clearJobs('sched-iso-a');
    await clearJobs('sched-iso-b');
    await call(
      'schedule_task',
      { name: 'mine', schedule: '0 9 * * *', input: 'go' },
      'sched-iso-a',
    );

    expect(await call('list_scheduled_tasks', {}, 'sched-iso-b')).toBe('No scheduled tasks.');
    expect(await call('cancel_scheduled_task', { name: 'mine' }, 'sched-iso-b')).toContain(
      'not found',
    );
    // Still there for its owner.
    expect(await call('list_scheduled_tasks', {}, 'sched-iso-a')).toContain('mine');
  });
});

describe('list, history, and cancel', () => {
  const tenant = 'sched-rw';
  beforeEach(() => clearJobs(tenant));

  it('reports an empty list plainly', async () => {
    expect(await call('list_scheduled_tasks', {}, tenant)).toBe('No scheduled tasks.');
  });

  it('lists a task with its schedule and run state', async () => {
    await call('schedule_task', { name: 'daily', schedule: '0 9 * * *', input: 'go' }, tenant);
    const out = await call('list_scheduled_tasks', {}, tenant);
    expect(out).toContain('daily');
    expect(out).toContain('0 9 * * *');
    expect(out).toContain('never run');
  });

  it('says so when a task has no history yet', async () => {
    await call('schedule_task', { name: 'fresh', schedule: '0 9 * * *', input: 'go' }, tenant);
    expect(await call('scheduled_task_runs', { name: 'fresh' }, tenant)).toContain('has not run');
  });

  it('404s history for an unknown task', async () => {
    expect(await call('scheduled_task_runs', { name: 'ghost' }, tenant)).toContain('not found');
  });

  it('cancels a task so it stops running', async () => {
    await call('schedule_task', { name: 'gone', schedule: '0 9 * * *', input: 'go' }, tenant);
    expect(await call('cancel_scheduled_task', { name: 'gone' }, tenant)).toContain('Cancelled');
    expect(await withPgContext(testEnv, () => getJob(testEnv, tenant, 'gone'))).toBeNull();
  });

  it('reports cancelling something that does not exist', async () => {
    expect(await call('cancel_scheduled_task', { name: 'never' }, tenant)).toContain('not found');
  });
});

describe('the frequency floor measures the whole cadence', () => {
  const from = new Date(Date.UTC(2026, 7, 7, 12, 59, 30));

  it.each([
    // Reports a wide FIRST gap but fires a minute apart right after — the
    // exact shape that slipped past a next-two-firings check.
    ['0,58,59 * * * *', 1],
    ['0,20,30,40,50 * * * *', 10],
  ])('reports the smallest gap for %s', (schedule, expected) => {
    expect(scheduleIntervalMinutes(schedule, from)).toBe(expected);
  });

  it.each([
    '0,58,59 * * * *',
    '0,20,30,40,50 * * * *',
    '*/5 * * * *',
  ])('refuses %s', async (schedule) => {
    const out = await call(
      'schedule_task',
      { name: 'dense', schedule, input: 'go' },
      'sched-floor',
    );
    expect(out).toContain('too frequent');
  });

  it('still accepts an evenly-spaced schedule above the floor', async () => {
    const out = await call(
      'schedule_task',
      { name: 'hourly', schedule: '0 * * * *', input: 'go' },
      'sched-floor',
    );
    expect(out).toContain('Scheduled');
  });
});

describe('per-manifest ownership', () => {
  const tenant = 'sched-own';
  beforeEach(() => clearJobs(tenant));

  it('hides another manifest tasks from list and history', async () => {
    await call(
      'schedule_task',
      { name: 'theirs', schedule: '0 9 * * *', input: 'go' },
      tenant,
      'agent-a',
    );

    expect(await call('list_scheduled_tasks', {}, tenant, 'agent-b')).toBe('No scheduled tasks.');
    expect(await call('scheduled_task_runs', { name: 'theirs' }, tenant, 'agent-b')).toContain(
      'not found',
    );
  });

  it('refuses to cancel another manifest task', async () => {
    await call(
      'schedule_task',
      { name: 'protected', schedule: '0 9 * * *', input: 'go' },
      tenant,
      'agent-a',
    );
    expect(await call('cancel_scheduled_task', { name: 'protected' }, tenant, 'agent-b')).toContain(
      'not found',
    );
    // Still owned and listed by its creator.
    expect(await call('list_scheduled_tasks', {}, tenant, 'agent-a')).toContain('protected');
  });

  it('refuses to take over another manifest task by name collision', async () => {
    // Replace semantics would otherwise reassign manifest_id and redirect the
    // job's unattended runs to a different agent's tool set.
    await call(
      'schedule_task',
      { name: 'shared', schedule: '0 9 * * *', input: 'original' },
      tenant,
      'agent-a',
    );
    const out = await call(
      'schedule_task',
      { name: 'shared', schedule: '0 10 * * *', input: 'hijacked' },
      tenant,
      'agent-b',
    );
    expect(out).toContain('name taken');

    const job = await withPgContext(testEnv, () => getJob(testEnv, tenant, 'shared'));
    expect(job?.manifest_id).toBe('agent-a');
    expect(job?.payload).toEqual({ input: 'original' });
  });

  it('still lets the owner replace its own task', async () => {
    await call(
      'schedule_task',
      { name: 'own', schedule: '0 9 * * *', input: 'v1' },
      tenant,
      'agent-a',
    );
    const out = await call(
      'schedule_task',
      { name: 'own', schedule: '0 11 * * *', input: 'v2' },
      tenant,
      'agent-a',
    );
    expect(out).toContain('Replaced');
  });
});
