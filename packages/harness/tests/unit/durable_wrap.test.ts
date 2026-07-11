/**
 * Phase-3 durable execution wrap.
 *
 * Pins the three contracts the wrap must hold:
 *
 *   1. With `env.AGENT_WORKFLOW` wired, `invoke()` creates a Workflow
 *      instance carrying tenant / manifest / messages params, polls
 *      its status, and decodes the JSON-encoded final result.
 *   2. With `env.AGENT_WORKFLOW` absent, the wrap logs a counter and
 *      delegates straight to the inner agent — so dev probes that
 *      don't wire the binding still work.
 *   3. A workflow that ends in an `errored` state propagates the error
 *      message back through `invoke()` so the caller can surface it.
 *
 * The wrap is unit-tested directly here rather than through `buildAgent`
 * to keep the test free of the full manifest build pipeline (auth /
 * skills / governance). The integration of `buildAgent` + the wrap is
 * trivial — one conditional call site in `builder.ts`.
 */

import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { wrapDurableAgent } from '../../src/manifests/builder';
import type { Agent, ChatMessage, InvokeInput, InvokeResult } from '../../src/patterns/types';

function fakeAgent(reply: ChatMessage): Agent {
  return {
    tools: [],
    pattern: 'react',
    manifestId: 'fake',
    manifestVersion: '1.0.0',
    async invoke(_input: InvokeInput): Promise<InvokeResult> {
      return { messages: [reply], final: reply };
    },
    async *streamEvents() {},
  };
}

interface StubInstance {
  id: string;
  // statuses produced in order — each `.status()` call shifts one off.
  statuses: Array<{
    status: 'queued' | 'running' | 'complete' | 'errored';
    output?: unknown;
    error?: { name: string; message: string };
  }>;
}

interface StubWorkflow {
  binding: NonNullable<Env['AGENT_WORKFLOW']>;
  /** Params recorded on each `.create()`. */
  created: Array<Record<string, unknown>>;
}

/**
 * Build a stub `AGENT_WORKFLOW` binding that returns the supplied
 * status sequence and records what params it was created with.
 */
function stubBinding(opts: { statuses: StubInstance['statuses'] }): StubWorkflow {
  const created: StubWorkflow['created'] = [];
  const binding = {
    async create(options?: { params?: unknown; id?: string }) {
      const params = (options?.params ?? {}) as Record<string, unknown>;
      created.push(params);
      const remaining = [...opts.statuses];
      return {
        id: 'wf-1',
        async status() {
          if (remaining.length === 0) {
            // If the test forgot to terminate the sequence, return the
            // final status repeatedly so polling stops on the first
            // terminal state encountered.
            const last = opts.statuses[opts.statuses.length - 1];
            return last ?? { status: 'unknown' };
          }
          return remaining.shift()!;
        },
        // Methods the wrap doesn't reach for; included so the stub
        // satisfies the WorkflowInstance shape structurally.
        async pause() {},
        async resume() {},
        async restart() {},
        async sendEvent() {},
        async terminate() {},
      };
    },
    async get(id: string) {
      throw new Error(`stub binding .get(${id}) — not used by the wrap`);
    },
    async createBatch() {
      throw new Error('stub binding .createBatch — not used by the wrap');
    },
  } as unknown as NonNullable<Env['AGENT_WORKFLOW']>;
  return { binding, created };
}

function makeCtx(env: Env, tenantId = 'acme'): RequestContext {
  return {
    env,
    auth: {
      ...ANONYMOUS,
      principal: { ...ANONYMOUS.principal, tenantId, subject: 'subj-1' },
    },
    limitState: newLimitState(),
  };
}

describe('wrapDurableAgent', () => {
  it('creates a Workflow instance with tenant + manifest + messages params', async () => {
    const stub = stubBinding({
      statuses: [
        { status: 'queued' },
        { status: 'running' },
        {
          status: 'complete',
          output: JSON.stringify({
            messages: [{ role: 'assistant', content: 'durable-answer' }],
            final: { role: 'assistant', content: 'durable-answer' },
          } satisfies InvokeResult),
        },
      ],
    });
    const env = { AGENT_WORKFLOW: stub.binding } as unknown as Env;
    const inner = fakeAgent({ role: 'assistant', content: 'inner-should-not-run' });
    const wrapped = wrapDurableAgent(inner, env, 'researcher');

    const result = await runWithContext(makeCtx(env), () =>
      wrapped.invoke({
        threadId: 'acme:thr-1',
        messages: [{ role: 'user', content: 'hello durable' }],
      }),
    );
    expect(result.final.content).toBe('durable-answer');
    expect(stub.created).toHaveLength(1);
    expect(stub.created[0]).toMatchObject({
      tenantId: 'acme',
      principalSubject: 'subj-1',
      manifestId: 'researcher',
      threadId: 'acme:thr-1',
      messages: [{ role: 'user', content: 'hello durable' }],
    });
  });

  it('falls back to the inner agent when AGENT_WORKFLOW is absent', async () => {
    const env = {} as unknown as Env;
    const inner = fakeAgent({ role: 'assistant', content: 'in-isolate-answer' });
    const wrapped = wrapDurableAgent(inner, env, 'researcher');
    const result = await runWithContext(makeCtx(env), () =>
      wrapped.invoke({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(result.final.content).toBe('in-isolate-answer');
  });

  it('propagates a workflow errored status as a thrown error', async () => {
    const stub = stubBinding({
      statuses: [
        { status: 'running' },
        {
          status: 'errored',
          error: { name: 'StepError', message: 'tool stack exploded' },
        },
      ],
    });
    const env = { AGENT_WORKFLOW: stub.binding } as unknown as Env;
    const inner = fakeAgent({ role: 'assistant', content: 'unreachable' });
    const wrapped = wrapDurableAgent(inner, env, 'researcher');

    await expect(
      runWithContext(makeCtx(env), () =>
        wrapped.invoke({ messages: [{ role: 'user', content: 'go' }] }),
      ),
    ).rejects.toThrow(/workflow errored: tool stack exploded/);
  });

  it('preserves the inner pattern name as a "durable:" prefix on the wrapped agent', () => {
    const inner = fakeAgent({ role: 'assistant', content: 'x' });
    const wrapped = wrapDurableAgent(inner, {} as Env, 'researcher');
    expect(wrapped.pattern).toBe('durable:react');
    expect(wrapped.manifestId).toBe('fake');
  });
});
