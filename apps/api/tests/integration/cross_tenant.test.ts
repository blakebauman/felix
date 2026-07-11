/**
 * Cross-tenant isolation: end-to-end proof that the hardening pass works
 * against real D1, real Durable Objects, and the live Hono router.
 *
 * The integration env doesn't configure `JWT_VERIFIERS`, so every inbound
 * request is anonymous and lands on tenant `default`. We exercise cross-
 * tenant invariants by:
 *
 *   - seeding non-default-tenant rows directly into D1 / spinning up DOs
 *     under non-default tenant ids, and
 *   - asserting that the anonymous route caller (tenant `default`) can't
 *     see them.
 *
 * Where a route is intrinsically tenant-scoped (e.g. `/jobs/<name>` is
 * keyed on the auth tenant), this is a strong end-to-end check. Where a
 * route is scoped by the DO key (ApprovalsDO), we hit the stub directly
 * with both tenant keys and verify they resolve to distinct storage.
 */

import { env, SELF } from 'cloudflare:test';
import { approvalsDoStub } from '@felix/harness/approvals/approvals-do';
import type { Env as AppEnv } from '@felix/harness/env';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './setup';

const testEnv = env as unknown as AppEnv;

beforeAll(async () => {
  await applyMigrations(testEnv.DB);
});

describe('/jobs cross-tenant scoping', () => {
  it("hides another tenant's jobs from the anonymous (default) caller", async () => {
    // Seed a job owned by `other-tenant` directly via D1 — bypasses the
    // route's auth-derived tenant_id so we can stage cross-tenant data.
    await testEnv.DB.prepare(
      `INSERT INTO jobs
         (tenant_id, name, schedule, manifest_id, last_run_at, next_run_at,
          last_status, last_error, created_at, payload_json)
         VALUES ('other-tenant', 'other-only', '0 0 * * *', 'quick', NULL, NULL,
                 '', '', ?, '{}')`,
    )
      .bind(Date.now())
      .run();

    // Create one under the default tenant via the route, to verify the
    // list filter doesn't accidentally hide the caller's own data.
    const create = await SELF.fetch('https://orchestrator.test/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'default-only', schedule: '', manifest_id: 'quick' }),
    });
    expect(create.status).toBe(201);

    // /jobs/list returns only `default`-tenant jobs.
    const list = await SELF.fetch('https://orchestrator.test/jobs/list');
    const { jobs } = (await list.json()) as { jobs: Array<{ name: string; tenant_id: string }> };
    const names = jobs.map((j) => j.name);
    expect(names).toContain('default-only');
    expect(names).not.toContain('other-only');
    // Every visible job is owned by the caller's tenant.
    for (const j of jobs) expect(j.tenant_id).toBe('default');

    // Direct GET for the other-tenant job 404s.
    const peek = await SELF.fetch('https://orchestrator.test/jobs/other-only');
    expect(peek.status).toBe(404);

    // Triggering the other-tenant job 404s (no cross-tenant manual run).
    const run = await SELF.fetch('https://orchestrator.test/jobs/run/other-only', {
      method: 'POST',
    });
    expect(run.status).toBe(404);

    // The other tenant's row is untouched in D1.
    const stillThere = await testEnv.DB.prepare(
      "SELECT name FROM jobs WHERE tenant_id = 'other-tenant' AND name = 'other-only'",
    ).first<{ name: string }>();
    expect(stillThere?.name).toBe('other-only');
  });
});

describe('thread-id smuggling', () => {
  it('rejects /chat thread_id that contains a tenant delimiter', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: 'quick',
        messages: [{ role: 'user', content: 'hello' }],
        thread_id: 'victim:smuggled-suffix',
      }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe('invalid_thread_id');
  });

  it('rejects /v1/chat/completions x-thread-id that contains a delimiter', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-thread-id': 'other-tenant:a2a-abc',
      },
      body: JSON.stringify({
        model: 'quick',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/x-thread-id/);
  });

  it('rejects /chat/history when called anonymously', async () => {
    // No JWT_VERIFIERS configured -> caller is anonymous; the route
    // demands a non-anonymous principal because anonymous tenants all
    // share `default` and would otherwise leak transcripts to each other.
    const resp = await SELF.fetch('https://orchestrator.test/chat/history/whatever');
    expect(resp.status).toBe(401);
  });
});

describe('ApprovalsDO tenant prefix', () => {
  it('keeps approvals with the same id but different tenants isolated', async () => {
    const sharedId = `shared-${crypto.randomUUID()}`;
    const now = Date.now();
    // Seed two approvals sharing the same `id` but different tenants —
    // the composite (tenant_id, id) PK allows it.
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO approvals
           (id, tenant_id, manifest_id, tool_name, call_signature, args_json,
            principal_subj, status, created_at)
           VALUES (?, 'tenant-a', 'quick', 'echo', ?, '{}', '', 'pending', ?)`,
      ).bind(sharedId, `sig-a-${sharedId}`, now),
      testEnv.DB.prepare(
        `INSERT INTO approvals
           (id, tenant_id, manifest_id, tool_name, call_signature, args_json,
            principal_subj, status, created_at)
           VALUES (?, 'tenant-b', 'quick', 'echo', ?, '{}', '', 'pending', ?)`,
      ).bind(sharedId, `sig-b-${sharedId}`, now),
    ]);

    // Decide on tenant-a's approval via the tenant-keyed DO stub.
    const stubA = approvalsDoStub(testEnv, 'tenant-a', sharedId);
    const decideResp = await stubA.fetch('https://do/decide', {
      method: 'POST',
      body: JSON.stringify({
        tenantId: 'tenant-a',
        id: sharedId,
        status: 'approved',
        decidedBy: 'operator-a',
      }),
    });
    expect(decideResp.status).toBe(200);

    // tenant-a's row is decided.
    const rowA = await testEnv.DB.prepare(
      'SELECT status, decided_by FROM approvals WHERE tenant_id = ? AND id = ?',
    )
      .bind('tenant-a', sharedId)
      .first<{ status: string; decided_by: string }>();
    expect(rowA?.status).toBe('approved');
    expect(rowA?.decided_by).toBe('operator-a');

    // tenant-b's row, sharing the id, is untouched.
    const rowB = await testEnv.DB.prepare(
      'SELECT status, decided_by FROM approvals WHERE tenant_id = ? AND id = ?',
    )
      .bind('tenant-b', sharedId)
      .first<{ status: string; decided_by: string }>();
    expect(rowB?.status).toBe('pending');
    expect(rowB?.decided_by).toBe('');

    // The DO stubs themselves are different instances (different storage
    // namespaces). They share an id only by accident.
    const stubB = approvalsDoStub(testEnv, 'tenant-b', sharedId);
    const getA = await stubA.fetch(`https://do/get?tenantId=tenant-a&id=${sharedId}`);
    const getB = await stubB.fetch(`https://do/get?tenantId=tenant-b&id=${sharedId}`);
    const fromA = (await getA.json()) as { status: string };
    const fromB = (await getB.json()) as { status: string };
    expect(fromA.status).toBe('approved');
    expect(fromB.status).toBe('pending');
  });
});

describe('manifest-name path confusion', () => {
  it("can't reach another tenant's R2 override via a slash in the manifest name", async () => {
    // Seed what would be tenant `victim`'s tenant-scoped R2 override. Its
    // object key (`manifests/victim/secret.json`) is a subset of the global
    // layer's keyspace (`manifests/<name>.json`), so before the fix a caller
    // in tenant `default` requesting name `victim/secret` would resolve it
    // via the global R2 layer and be able to invoke an agent built from it.
    await testEnv.BUNDLES.put(
      'manifests/victim/secret.json',
      JSON.stringify({
        apiVersion: 'orchestrator/v1',
        kind: 'Agent',
        metadata: { name: 'secret' },
        spec: {
          pattern: 'react',
          model: { provider: 'workers-ai', name: '@cf/meta/llama-3.1-8b-instruct' },
          system_prompt: { inline: 'victim private prompt' },
        },
      }),
    );

    // /chat body carries `manifest` as a bare string; the resolver rejects
    // the slash-containing name before any R2 read, so it 404s instead of
    // resolving the seeded victim object.
    const chat = await SELF.fetch('https://orchestrator.test/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: 'victim/secret',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(chat.status).toBe(404);
    const chatBody = (await chat.json()) as { error: string };
    expect(chatBody.error).toBe('unknown_manifest');

    // The /manifests param surface rejects the slash at param validation.
    const resolve = await SELF.fetch('https://orchestrator.test/manifests/victim%2Fsecret');
    expect([400, 404]).toContain(resolve.status);
  });
});

describe('/audit cross-tenant scoping', () => {
  it('only returns audit events for the caller tenant', async () => {
    const tenants = ['default', 'other-tenant'] as const;
    const now = Date.now();
    // One event per tenant.
    for (const t of tenants) {
      await testEnv.DB.prepare(
        `INSERT INTO audit_events
           (id, tenant_id, ts, event_type, manifest_id, principal_subj, status, payload_json)
           VALUES (?, ?, ?, 'tool_call', 'quick', '', '', '{}')`,
      )
        .bind(`evt-${t}-${now}`, t, now)
        .run();
    }
    const resp = await SELF.fetch('https://orchestrator.test/audit');
    const { events } = (await resp.json()) as {
      events: Array<{ tenant_id: string }>;
    };
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.tenant_id).toBe('default');
  });
});
