/**
 * Scheduled-job execution against real Postgres.
 *
 * The sweep used to store jobs and never run them; these pin the parts of the
 * new execution path that don't require a live model: which jobs are picked up
 * at all, the compare-and-swap slot claim that keeps overlapping ticks from
 * double-running, the per-tick execution bound, and the fact that the agent
 * path is genuinely entered (proved by a job pointing at a manifest that does
 * not exist, which surfaces as an `error` rather than a silent `scheduled`).
 */

import { env, SELF } from 'cloudflare:test';
import type { Env as AppEnv } from '@felix/harness/env';
import { runScheduledJobs } from '@felix/harness/jobs/cron';
import { jobExecutes, jobInput, jobThreadId } from '@felix/harness/jobs/execute';
import type { JobRecord } from '@felix/harness/jobs/models';
import { claimJobSlot, getJob, upsertJob } from '@felix/harness/jobs/store';
import type { ToolProvider } from '@felix/harness/tools/provider';
import { beforeEach, describe, expect, it } from 'vitest';
import { withPgContext } from './setup';

const testEnv = env as unknown as AppEnv;

/** A provider with no tools — enough to reach manifest resolution. */
const emptyTools: ToolProvider = {
  register: () => {},
  get: () => undefined,
  names: () => [],
  resolve: () => [],
} as unknown as ToolProvider;

/** Every minute, so a sweep at any clock time matches. */
const EVERY_MINUTE = '* * * * *';

function job(over: Partial<JobRecord> & { tenant_id: string; name: string }): JobRecord {
  return {
    schedule: EVERY_MINUTE,
    manifest_id: '',
    last_run_at: null,
    next_run_at: 0,
    last_status: '',
    last_error: '',
    created_at: Date.now(),
    payload: {},
    enabled: false,
    ...over,
  } as JobRecord;
}

async function seed(record: JobRecord): Promise<void> {
  await withPgContext(testEnv, () => upsertJob(testEnv, record));
}

async function read(tenantId: string, name: string): Promise<JobRecord | null> {
  return withPgContext(testEnv, () => getJob(testEnv, tenantId, name));
}

async function sweep(tenantId: string, at = new Date()): Promise<void> {
  await withPgContext(testEnv, () => runScheduledJobs(testEnv, emptyTools, at));
  // `tenantId` is only here to make each test's intent readable — the sweep is
  // deliberately cross-tenant and re-derives the tenant from each row.
  void tenantId;
}

describe('jobExecutes', () => {
  const base = job({ tenant_id: 't', name: 'n', enabled: true, manifest_id: 'quick' });

  it('requires enabled, a manifest, and an input', () => {
    expect(jobExecutes({ ...base, payload: { input: 'go' } })).toBe(true);
    expect(jobExecutes({ ...base, payload: { input: 'go' }, enabled: false })).toBe(false);
    expect(jobExecutes({ ...base, payload: { input: 'go' }, manifest_id: '' })).toBe(false);
    expect(jobExecutes({ ...base, payload: {} })).toBe(false);
  });

  it('treats a blank or non-string input as absent', () => {
    expect(jobInput({ ...base, payload: { input: '   ' } })).toBeNull();
    expect(jobInput({ ...base, payload: { input: 42 } })).toBeNull();
    expect(jobInput({ ...base, payload: { input: ' go ' } })).toBe('go');
  });

  it('gives each firing its own thread', () => {
    expect(jobThreadId(base, 1000)).not.toBe(jobThreadId(base, 2000));
    expect(jobThreadId(base, 1000)).toContain('t:job-n-');
  });
});

describe('claimJobSlot', () => {
  const tenant = 'job-claim';

  beforeEach(async () => {
    await seed(job({ tenant_id: tenant, name: 'c1', next_run_at: 1_000 }));
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const results = await withPgContext(testEnv, () =>
      Promise.all([
        claimJobSlot(testEnv, tenant, 'c1', 1_000, 2_000),
        claimJobSlot(testEnv, tenant, 'c1', 1_000, 2_000),
      ]),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('fails when the slot has already moved', async () => {
    expect(
      await withPgContext(testEnv, () => claimJobSlot(testEnv, tenant, 'c1', 999, 2_000)),
    ).toBe(false);
  });

  it('advances the slot on a win', async () => {
    await withPgContext(testEnv, () => claimJobSlot(testEnv, tenant, 'c1', 1_000, 5_000));
    expect((await read(tenant, 'c1'))?.next_run_at).toBe(5_000);
  });
});

describe('the sweep', () => {
  it('records a disabled job without executing it', async () => {
    const tenant = 'job-disabled';
    await seed(
      job({
        tenant_id: tenant,
        name: 'quiet',
        manifest_id: 'does-not-exist',
        payload: { input: 'go' },
        enabled: false,
      }),
    );

    await sweep(tenant);

    const after = await read(tenant, 'quiet');
    // `scheduled` is the bookkeeping-only outcome. Had it executed, the
    // missing manifest would have produced `error` instead.
    expect(after?.last_status).toBe('scheduled');
    expect(after?.last_error).toBe('');
  });

  it('executes an enabled job and surfaces a bad manifest as an error', async () => {
    const tenant = 'job-enabled';
    await seed(
      job({
        tenant_id: tenant,
        name: 'runs',
        manifest_id: 'no-such-manifest',
        payload: { input: 'go' },
        enabled: true,
      }),
    );

    await sweep(tenant);

    const after = await read(tenant, 'runs');
    // Reaching manifest resolution at all proves the execution path is entered
    // rather than the old store-and-forget behavior.
    expect(after?.last_status).toBe('error');
    expect(after?.last_error).toContain('no-such-manifest');
  });

  it('advances next_run_at so the same slot is not re-run', async () => {
    const tenant = 'job-advance';
    await seed(job({ tenant_id: tenant, name: 'once', next_run_at: 1_000 }));

    const at = new Date();
    await sweep(tenant, at);

    const after = await read(tenant, 'once');
    expect(after?.next_run_at).not.toBe(1_000);
    expect(after?.next_run_at ?? 0).toBeGreaterThan(at.getTime());
  });

  it('does not execute when no tool provider is supplied', async () => {
    const tenant = 'job-no-tools';
    await seed(
      job({
        tenant_id: tenant,
        name: 'toolless',
        manifest_id: 'no-such-manifest',
        payload: { input: 'go' },
        enabled: true,
      }),
    );

    await withPgContext(testEnv, () => runScheduledJobs(testEnv, undefined, new Date()));

    expect((await read(tenant, 'toolless'))?.last_status).toBe('scheduled');
  });

  it('defers work past the per-tick execution cap instead of dropping it', async () => {
    const tenant = 'job-cap';
    // The cap is 5; seed more executable jobs than that.
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    for (const name of names) {
      await seed(
        job({
          tenant_id: tenant,
          name,
          manifest_id: 'no-such-manifest',
          payload: { input: 'go' },
          enabled: true,
        }),
      );
    }

    await sweep(tenant);

    const rows = await Promise.all(names.map((n) => read(tenant, n)));
    const executed = rows.filter((r) => r?.last_status === 'error');
    const deferred = rows.filter((r) => r?.last_status === '');
    expect(executed.length).toBeLessThanOrEqual(5);
    // Deferred jobs keep their original slot so the next tick picks them up —
    // they must not be silently consumed.
    expect(deferred.length).toBeGreaterThan(0);
    for (const row of deferred) expect(row?.next_run_at).toBe(0);
  });
});

describe('POST /jobs enabled semantics', () => {
  async function post(body: Record<string, unknown>) {
    const resp = await SELF.fetch('https://orchestrator.test/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: resp.status, job: (await resp.json()) as JobRecord };
  }

  it('enables a brand-new job when `enabled` is omitted', async () => {
    // Defaulting to false here would make a freshly-created job silently never
    // run — the failure mode is invisible until someone notices nothing fired.
    const { status, job: created } = await post({
      name: 'enabled-default',
      schedule: '0 9 * * *',
      manifest_id: 'quick',
      payload: { input: 'go' },
    });
    expect(status).toBe(201);
    expect(created.enabled).toBe(true);
  });

  it('honors an explicit false', async () => {
    const { job: created } = await post({
      name: 'enabled-explicit-false',
      schedule: '0 9 * * *',
      enabled: false,
    });
    expect(created.enabled).toBe(false);
  });

  it('preserves an existing setting when `enabled` is omitted on update', async () => {
    await post({ name: 'enabled-preserve', schedule: '0 9 * * *', enabled: false });
    // Re-POSTing to change the schedule must not silently switch execution back on.
    const { job: updated } = await post({ name: 'enabled-preserve', schedule: '0 10 * * *' });
    expect(updated.enabled).toBe(false);
    expect(updated.schedule).toBe('0 10 * * *');
  });

  it('computes a next run for a schedule longer than a day', async () => {
    // A null next_run_at would drop the job out of the sweep forever.
    const { job: created } = await post({
      name: 'weekly-job',
      schedule: '0 9 * * 1',
      manifest_id: 'quick',
      payload: { input: 'go' },
    });
    expect(created.next_run_at).not.toBeNull();
  });
});
