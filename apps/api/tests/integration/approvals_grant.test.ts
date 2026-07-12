/**
 * Approval GRANT lifecycle — TTL, one-shot consumption, and principal binding.
 *
 * These exercise `applyApprovals` end-to-end against real D1 + the ApprovalsDO
 * (through `supersedeViaDO`), driving the wrapper inside a hand-built
 * RequestContext so we control the acting subject. The H2 fix hardens a grant
 * that used to be a permanent, tenant-wide, replayable authorization:
 *
 *   (i)   a `one_shot` grant runs once, then re-requests on the next call;
 *   (ii)  an expired (TTL) grant re-requests instead of replaying;
 *   (iii) a `bind_principal` grant is NOT reusable by a different subject;
 *   (iv)  a grant with no new fields still replays tenant-wide (unchanged).
 */

import { env } from 'cloudflare:test';
import type { ApprovalRule } from '@felix/harness/approvals/models';
import { decideRequest, getRequest } from '@felix/harness/approvals/store';
import { applyApprovals } from '@felix/harness/approvals/wrap';
import type { AuthContext } from '@felix/harness/auth/context';
import {
  disposeContextDb,
  newLimitState,
  type RequestContext,
  runWithContext,
} from '@felix/harness/context';
import { getDb } from '@felix/harness/db/client';
import type { Env as AppEnv } from '@felix/harness/env';
import { defineTool, isWrapperDeny, type Tool, type ToolOutput } from '@felix/harness/tools/types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withPgContext } from './setup';

const testEnv = env as unknown as AppEnv;
const TENANT = 'default';

function ctxFor(subject: string): RequestContext {
  const auth: AuthContext = {
    principal: { subject, tenantId: TENANT, scopes: [], issuer: 'test' },
    outboundToken: async () => '',
  };
  return { env: testEnv, auth, limitState: newLimitState() };
}

/** Fresh tool with an execution counter so each test isolates its own runs. */
function makeTool(name: string): { tool: Tool; state: { count: number } } {
  const state = { count: 0 };
  const tool = defineTool({
    name,
    description: 'gated',
    args: z.object({ target: z.string() }),
    async handler({ target }) {
      state.count += 1;
      return `ran:${target}`;
    },
  });
  return { tool, state };
}

function content(out: ToolOutput): string {
  return typeof out === 'string' ? out : out.content;
}

function approvalIdOf(out: ToolOutput): string | undefined {
  return content(out).match(/approval_id=([0-9a-f-]+)/)?.[1];
}

async function run(
  wrapped: Tool,
  args: Record<string, unknown>,
  subject: string,
): Promise<ToolOutput> {
  const ctx = ctxFor(subject);
  try {
    return await runWithContext(ctx, () => wrapped.executor.execute(args));
  } finally {
    disposeContextDb(ctx);
  }
}

async function approve(id: string): Promise<void> {
  const res = await withPgContext(testEnv, () =>
    decideRequest(testEnv, TENANT, id, { status: 'approved', decidedBy: 'op' }),
  );
  expect(res.outcome).toBe('decided');
}

async function statusOf(id: string): Promise<string | undefined> {
  return (await withPgContext(testEnv, () => getRequest(testEnv, TENANT, id)))?.status;
}

describe('one_shot approval grants', () => {
  it('executes once then re-requests on the second call', async () => {
    const { tool, state } = makeTool('danger');
    const rule = { id: 'r', tools: ['danger'], one_shot: true } as ApprovalRule;
    const wrapped = applyApprovals([tool], [rule], 'm-oneshot')[0]!;
    const args = { target: 'prod' };

    const first = await run(wrapped, args, 'alice');
    expect(isWrapperDeny(first)).toBe(true);
    const id1 = approvalIdOf(first)!;
    expect(id1).toBeTruthy();
    await approve(id1);

    // First post-approval call runs the tool exactly once.
    const second = await run(wrapped, args, 'alice');
    expect(isWrapperDeny(second)).toBe(false);
    expect(content(second)).toBe('ran:prod');
    expect(state.count).toBe(1);
    expect(await statusOf(id1)).toBe('consumed');

    // Second call re-requests with a NEW id and does NOT execute again.
    const third = await run(wrapped, args, 'alice');
    expect(isWrapperDeny(third)).toBe(true);
    const id2 = approvalIdOf(third)!;
    expect(id2).toBeTruthy();
    expect(id2).not.toBe(id1);
    expect(state.count).toBe(1);
  });
});

describe('TTL (expiring) approval grants', () => {
  it('stamps expires_at = decided_at + ttl at decide time', async () => {
    const { tool } = makeTool('danger');
    const rule = { id: 'r', tools: ['danger'], ttl_seconds: 3600 } as ApprovalRule;
    const wrapped = applyApprovals([tool], [rule], 'm-ttl-stamp')[0]!;

    const first = await run(wrapped, { target: 'x' }, 'alice');
    const id1 = approvalIdOf(first)!;
    await approve(id1);

    const row = await withPgContext(testEnv, () => getRequest(testEnv, TENANT, id1));
    expect(row).not.toBeNull();
    expect(row?.expires_at).not.toBeNull();
    expect((row?.expires_at ?? 0) - (row?.decided_at ?? 0)).toBe(3600 * 1000);
  });

  it('re-requests once the grant has expired', async () => {
    const { tool, state } = makeTool('danger');
    const rule = { id: 'r', tools: ['danger'], ttl_seconds: 3600 } as ApprovalRule;
    const wrapped = applyApprovals([tool], [rule], 'm-ttl-expire')[0]!;
    const args = { target: 'y' };

    const first = await run(wrapped, args, 'alice');
    const id1 = approvalIdOf(first)!;
    await approve(id1);

    // Force the grant into the past — deterministic vs. sleeping on a real TTL.
    await getDb(testEnv)`
      UPDATE approvals SET expires_at = ${Date.now() - 1000}
        WHERE tenant_id = ${TENANT} AND id = ${id1}
    `;

    const second = await run(wrapped, args, 'alice');
    expect(isWrapperDeny(second)).toBe(true); // expired -> re-request
    const id2 = approvalIdOf(second)!;
    expect(id2).not.toBe(id1);
    expect(state.count).toBe(0); // never executed
    expect(await statusOf(id1)).toBe('expired');
  });
});

describe('principal-bound approval grants', () => {
  it('is NOT reusable by a different subject', async () => {
    const { tool, state } = makeTool('danger');
    const rule = { id: 'r', tools: ['danger'], bind_principal: true } as ApprovalRule;
    const wrapped = applyApprovals([tool], [rule], 'm-bind')[0]!;
    const args = { target: 'z' };

    // Alice requests + is approved + runs.
    const aliceReq = await run(wrapped, args, 'alice');
    const idA = approvalIdOf(aliceReq)!;
    await approve(idA);
    const aliceRun = await run(wrapped, args, 'alice');
    expect(isWrapperDeny(aliceRun)).toBe(false);
    expect(state.count).toBe(1);

    // Bob, same tenant + tool + args, gets a DISTINCT signature -> re-request,
    // NOT a replay of Alice's grant.
    const bobOut = await run(wrapped, args, 'bob');
    expect(isWrapperDeny(bobOut)).toBe(true);
    const idB = approvalIdOf(bobOut)!;
    expect(idB).toBeTruthy();
    expect(idB).not.toBe(idA);
    expect(state.count).toBe(1); // Bob never executed on Alice's grant
  });
});

describe('legacy (no new fields) approval grants', () => {
  it('still replays tenant-wide across calls and subjects', async () => {
    const { tool, state } = makeTool('danger');
    const rule = { id: 'r', tools: ['danger'] } as ApprovalRule;
    const wrapped = applyApprovals([tool], [rule], 'm-plain')[0]!;
    const args = { target: 'w' };

    const first = await run(wrapped, args, 'alice');
    const id1 = approvalIdOf(first)!;
    await approve(id1);

    // Replays for the same subject...
    expect(content(await run(wrapped, args, 'alice'))).toBe('ran:w');
    expect(content(await run(wrapped, args, 'alice'))).toBe('ran:w');
    // ...and for a different subject on the same tenant (subject-agnostic).
    expect(content(await run(wrapped, args, 'bob'))).toBe('ran:w');
    expect(state.count).toBe(3);
    expect(await statusOf(id1)).toBe('approved'); // still live, never consumed
  });
});
