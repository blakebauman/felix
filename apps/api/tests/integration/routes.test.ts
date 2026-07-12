/**
 * D1-backed route smoke tests. Applies the production migration to
 * miniflare's in-memory database, then drives the routes that don't
 * require a live LLM: /audit, /plans, /jobs, /approvals.
 */

import { env, SELF } from 'cloudflare:test';
import { getDb } from '@felix/harness/db/client';
import type { Env as AppEnv } from '@felix/harness/env';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './setup';

// The `cloudflare:test` env is typed as Cloudflare.Env (the bindings declared
// in vitest.config.ts). For tests that pass it into project code typed
// against our richer Env shape, cast through a structural alias.
const testEnv = env as unknown as AppEnv;

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
});

describe('/audit', () => {
  it('lists events with a well-formed envelope', async () => {
    // Postgres state is shared across test files (unlike the old per-run
    // miniflare D1), so earlier suites may already have written events for
    // this tenant — assert the envelope shape, not emptiness.
    const resp = await SELF.fetch('https://orchestrator.test/audit');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { events: Array<{ tenant_id?: string }> };
    expect(Array.isArray(body.events)).toBe(true);
    for (const e of body.events) expect(e.tenant_id).toBe('default');
  });
});

describe('/audit/metrics', () => {
  it('rolls up tool_call rows by (manifest, tool, transport, status, error_code)', async () => {
    // Seed a few representative rows directly through D1 so we don't
    // need a live model. Two oks, one provider_error, one timeout, all
    // under manifest `quick`.
    const now = Date.now();
    const rows = [
      { tool: 'echo', transport: 'local', status: 'ok', err: null },
      { tool: 'echo', transport: 'local', status: 'ok', err: null },
      { tool: 'fetch', transport: 'mcp', status: 'error', err: 'provider_error' },
      { tool: 'fetch', transport: 'mcp', status: 'error', err: 'timeout' },
    ];
    const sql = getDb(testEnv);
    for (const r of rows) {
      const payload: Record<string, unknown> = {
        tool: r.tool,
        transport: r.transport,
        duration_ms: 12,
      };
      if (r.err) payload.error_code = r.err;
      await sql`
        INSERT INTO audit_events
          (id, tenant_id, ts, event_type, manifest_id, principal_subj, status, payload_json)
          VALUES (${crypto.randomUUID()}, 'default', ${now}, 'tool_call', 'quick', '', ${r.status}, ${payload})
      `;
    }

    const resp = await SELF.fetch(
      `https://orchestrator.test/audit/metrics?since=${now - 1000}&manifest_id=quick`,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      rows: Array<{
        manifest_id: string;
        tool: string;
        transport: string;
        status: string;
        error_code: string | null;
        count: number;
      }>;
    };

    const byKey = new Map(
      body.rows.map((r) => [
        `${r.manifest_id}|${r.tool}|${r.transport}|${r.status}|${r.error_code ?? ''}`,
        r,
      ]),
    );
    expect(byKey.get('quick|echo|local|ok|')?.count).toBe(2);
    expect(byKey.get('quick|fetch|mcp|error|provider_error')?.count).toBe(1);
    expect(byKey.get('quick|fetch|mcp|error|timeout')?.count).toBe(1);
  });
});

describe('/plans', () => {
  it('returns an empty list when no plans exist', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/plans');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { plans: unknown[] };
    expect(Array.isArray(body.plans)).toBe(true);
    expect(body.plans).toEqual([]);
  });
});

describe('/jobs', () => {
  it('round-trips a job through POST → GET', async () => {
    const created = await SELF.fetch('https://orchestrator.test/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nightly', schedule: '0 0 * * *', manifest_id: 'quick' }),
    });
    expect(created.status).toBe(201);
    const job = (await created.json()) as { name: string; schedule: string };
    expect(job).toMatchObject({ name: 'nightly', schedule: '0 0 * * *' });

    const fetched = await SELF.fetch('https://orchestrator.test/jobs/nightly');
    expect(fetched.status).toBe(200);
    const got = (await fetched.json()) as { name: string; manifest_id: string };
    expect(got).toMatchObject({ name: 'nightly', manifest_id: 'quick' });

    const list = await SELF.fetch('https://orchestrator.test/jobs/list');
    const { jobs } = (await list.json()) as { jobs: Array<{ name: string }> };
    expect(jobs.map((j) => j.name)).toContain('nightly');
  });

  it('404s on an unknown job name', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/jobs/does-not-exist');
    expect(resp.status).toBe(404);
  });
});

describe('/approvals/:id/decide via ApprovalsDO', () => {
  it('serializes concurrent decisions — exactly one wins, the loser gets 409 (finality)', async () => {
    // Seed a pending approval directly through D1 — bypasses the wrap
    // path so we don't need a model.
    const id = crypto.randomUUID();
    await getDb(testEnv)`
      INSERT INTO approvals
        (id, tenant_id, manifest_id, tool_name, call_signature, args_json, principal_subj, status, created_at)
        VALUES (${id}, 'default', 'quick', 'echo', ${`sig-${id}`}, '{}', '', 'pending', ${Date.now()})
    `;

    // Fire two concurrent decide requests with conflicting statuses. The
    // DO's blockConcurrencyWhile must serialize them so the final row
    // reflects exactly one of the two writers.
    const [approve, deny] = await Promise.all([
      SELF.fetch(`https://orchestrator.test/approvals/${id}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      }),
      SELF.fetch(`https://orchestrator.test/approvals/${id}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'denied' }),
      }),
    ]);
    // Decisions are a one-way transition: the DO's blockConcurrencyWhile
    // serializes the racing calls, so exactly one sees the row still
    // `pending` (200) and the other is rejected as already decided (409).
    const statuses = [approve.status, deny.status].sort();
    expect(statuses).toEqual([200, 409]);

    const rows = await getDb(testEnv)<{ status: string }[]>`
      SELECT status FROM approvals WHERE id = ${id}
    `;
    const row = rows[0];
    expect(['approved', 'denied']).toContain(row!.status);

    const final = await SELF.fetch(`https://orchestrator.test/approvals/${id}`);
    const got = (await final.json()) as { status: string };
    expect(got.status).toBe(row!.status);
  });
});

describe('skill activation — D1 round-trip', () => {
  it('list_skills returns null overlay until setActivated writes one', async () => {
    const { getActivated, setActivated } = await import('@felix/harness/skills/activation-store');
    const before = await getActivated(testEnv, 'tenant-a', 'manifest-x');
    expect(before).toBeNull();

    await setActivated(testEnv, 'tenant-a', 'manifest-x', ['skill-a', 'skill-b']);
    const after = await getActivated(testEnv, 'tenant-a', 'manifest-x');
    expect(after).toEqual(['skill-a', 'skill-b']);

    // Different tenant must not see the overlay.
    const isolated = await getActivated(testEnv, 'tenant-b', 'manifest-x');
    expect(isolated).toBeNull();
  });
});
