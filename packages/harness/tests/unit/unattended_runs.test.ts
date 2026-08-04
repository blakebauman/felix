/**
 * Unattended-run marker and the approval gate that reads it.
 *
 * The deny path is asserted to happen WITHOUT touching the approval store —
 * that is what makes it safe to reach from a cron tick with no database
 * round-trip, and it is also the proof that a live grant is never consulted,
 * let alone consumed, when nobody is watching.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApprovalRule } from '../../src/approvals/models';
import { applyApprovals } from '../../src/approvals/wrap';
import { ANONYMOUS } from '../../src/auth/context';
import {
  buildAnonymousContext,
  buildBackgroundContext,
  isUnattended,
  newLimitState,
  type RequestContext,
  runWithContext,
} from '../../src/context';
import type { Env } from '../../src/env';
import { wrapDurableAgent } from '../../src/manifests/builder';
import type { Agent } from '../../src/patterns/types';
import { defineTool, isWrapperDeny, type ToolOutput } from '../../src/tools/types';
import type { AgentWorkflowParams } from '../../src/workflows/types';

function content(out: ToolOutput): string {
  return typeof out === 'string' ? out : out.content;
}

/**
 * An env whose Postgres binding throws on access. The approval store is never
 * expected to be consulted on the unattended deny path, so a lookup surfaces
 * as a failure rather than passing silently.
 *
 * The audit queue is stubbed because `recordEvent` otherwise falls back to
 * writing audit rows straight to Postgres — that write is fire-and-forget and
 * would trip the guard for a reason unrelated to what these tests assert.
 */
function envWithoutDb(): Env {
  return {
    AUDIT_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    get HYPERDRIVE(): never {
      throw new Error('the approval store must not be consulted on an unattended deny');
    },
  } as unknown as Env;
}

const gated = defineTool({
  name: 'danger',
  description: 'gated tool',
  args: z.object({ target: z.string() }),
  async handler({ target }) {
    return `ran:${target}`;
  },
});

describe('buildBackgroundContext', () => {
  it('marks the run unattended', () => {
    expect(buildBackgroundContext({} as Env).unattended).toBe(true);
  });

  it('sets the tenant explicitly rather than inheriting the anonymous default', () => {
    const ctx = buildBackgroundContext({} as Env, { tenantId: 'acme' });
    expect(ctx.auth.principal.tenantId).toBe('acme');
  });

  it('keeps the anonymous tenant when none is supplied', () => {
    expect(buildBackgroundContext({} as Env).auth.principal.tenantId).toBe(
      ANONYMOUS.principal.tenantId,
    );
  });

  it('carries a subject when one is supplied', () => {
    expect(
      buildBackgroundContext({} as Env, { subject: 'job:nightly' }).auth.principal.subject,
    ).toBe('job:nightly');
  });

  it('does not mark an ordinary anonymous context unattended', () => {
    // An unauthenticated request in development is anonymous but still has a
    // person behind it — the two concepts must not collapse.
    expect(buildAnonymousContext({} as Env).unattended).toBeUndefined();
  });
});

describe('isUnattended', () => {
  it('is false with no context installed', () => {
    expect(isUnattended()).toBe(false);
  });

  it('reflects the installed context', async () => {
    const attended: RequestContext = {
      env: {} as Env,
      auth: ANONYMOUS,
      limitState: newLimitState(),
    };
    await runWithContext(attended, async () => {
      expect(isUnattended()).toBe(false);
    });
    await runWithContext(buildBackgroundContext({} as Env), async () => {
      expect(isUnattended()).toBe(true);
    });
  });
});

describe('approval gate under an unattended run', () => {
  const rule = { id: 'r', tools: ['danger'] } as ApprovalRule;

  it('denies without consulting the approval store', async () => {
    const wrapped = applyApprovals([gated], [rule], 'm')[0]!;
    const ctx = buildBackgroundContext(envWithoutDb(), { tenantId: 'acme' });

    const out = await runWithContext(ctx, () => wrapped.executor.execute({ target: 'prod' }));

    expect(isWrapperDeny(out)).toBe(true);
    expect(content(out)).toContain('[approval unavailable]');
    expect(content(out)).toContain('unattended');
    // The remedy is named so an operator reading the transcript knows the knob.
    expect(content(out)).toContain('allow_unattended');
  });

  it('does not gate a tool the rule does not cover', async () => {
    const other = defineTool({
      name: 'safe',
      description: 'ungated',
      args: z.object({}).passthrough(),
      async handler() {
        return 'ok';
      },
    });
    const wrapped = applyApprovals([other], [rule], 'm')[0]!;
    const ctx = buildBackgroundContext(envWithoutDb());
    expect(content(await runWithContext(ctx, () => wrapped.executor.execute({})))).toBe('ok');
  });

  it('falls through to the normal flow when the rule opts in', async () => {
    // With `allow_unattended`, the gate proceeds to the store as usual — which
    // here means hitting the guard env and throwing, proving the short-circuit
    // is genuinely bypassed rather than silently allowing.
    const optedIn = { id: 'r', tools: ['danger'], allow_unattended: true } as ApprovalRule;
    const wrapped = applyApprovals([gated], [optedIn], 'm')[0]!;
    const ctx = buildBackgroundContext(envWithoutDb());

    await expect(
      runWithContext(ctx, () => wrapped.executor.execute({ target: 'prod' })),
    ).rejects.toThrow(/must not be consulted|HYPERDRIVE/);
  });

  it('leaves attended runs on the pre-existing path', async () => {
    const wrapped = applyApprovals([gated], [rule], 'm')[0]!;
    const attended: RequestContext = {
      env: envWithoutDb(),
      auth: ANONYMOUS,
      limitState: newLimitState(),
    };
    // Reaching the store is the pre-existing behavior for an attended run.
    await expect(
      runWithContext(attended, () => wrapped.executor.execute({ target: 'prod' })),
    ).rejects.toThrow(/must not be consulted|HYPERDRIVE/);
  });
});

describe('durable execution carries the marker across the isolate boundary', () => {
  /** A stub AGENT_WORKFLOW binding that captures the params it was created with. */
  function bindingCapturing(seen: AgentWorkflowParams[]): Env {
    return {
      AUDIT_QUEUE: { send: async () => {}, sendBatch: async () => {} },
      AGENT_WORKFLOW: {
        create: async ({ params }: { params: AgentWorkflowParams }) => {
          seen.push(params);
          return {
            status: async () => ({ status: 'complete', output: JSON.stringify({ final: {} }) }),
          };
        },
      },
    } as unknown as Env;
  }

  const innerAgent = (): Agent => ({
    tools: [],
    pattern: 'react',
    manifestId: 'm',
    manifestVersion: '1',
    async invoke() {
      return { final: { role: 'assistant', content: 'inner' }, messages: [] } as never;
    },
    // Never reached — the durable wrap routes `invoke` through the workflow
    // binding — but the Agent contract requires it.
    async *streamEvents() {
      yield { type: 'final', content: 'inner' } as never;
    },
  });

  it('stamps unattended onto the workflow params when the caller is unattended', async () => {
    const seen: AgentWorkflowParams[] = [];
    const env = bindingCapturing(seen);
    const durable = wrapDurableAgent(innerAgent(), env, 'm');

    await runWithContext(buildBackgroundContext(env, { tenantId: 'acme' }), () =>
      durable.invoke({ messages: [{ role: 'user', content: 'go' }] }),
    );

    expect(seen).toHaveLength(1);
    // Without this the workflow rebuilds an attended context and human
    // approval grants apply again inside the durable run.
    expect(seen[0]!.unattended).toBe(true);
    expect(seen[0]!.tenantId).toBe('acme');
  });

  it('leaves the params unflagged for an ordinary attended invocation', async () => {
    const seen: AgentWorkflowParams[] = [];
    const env = bindingCapturing(seen);
    const durable = wrapDurableAgent(innerAgent(), env, 'm');
    const attended: RequestContext = {
      env,
      auth: ANONYMOUS,
      limitState: newLimitState(),
    };

    await runWithContext(attended, () =>
      durable.invoke({ messages: [{ role: 'user', content: 'go' }] }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.unattended).toBeUndefined();
  });
});
