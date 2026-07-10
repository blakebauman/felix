import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { applyLimits } from '../../src/limits/wrap';
import { applyPolicies } from '../../src/policy/wrap';
import { defineTool, isWrapperDeny, type ToolOutput } from '../../src/tools/types';

/** Wrapper deny outputs are now structured `{ content, metadata }`; tests
 *  used to coerce with `String(out)`. Use this helper so assertions still
 *  read content regardless of whether the wrapper denied or passed. */
function content(out: ToolOutput): string {
  return typeof out === 'string' ? out : out.content;
}

function fakeEnv(): Env {
  // The wrappers only touch ctx.env when an audit write happens, and audit
  // writes are fire-and-forget when execCtx is absent. We can supply a
  // partial env in unit tests; cast through unknown to silence the type.
  return {} as unknown as Env;
}

function fakeCtx(): RequestContext {
  return { env: fakeEnv(), auth: ANONYMOUS, limitState: newLimitState() };
}

const echo = defineTool({
  name: 'echo',
  description: 'echo back input',
  args: z.object({ text: z.string() }),
  async handler({ text }) {
    return text;
  },
});

describe('limits wrapper', () => {
  it('blocks once max_tool_calls is reached', async () => {
    const wrapped = applyLimits(
      [echo],
      {
        max_tool_calls: 1,
        max_wall_clock_seconds: null,
        max_peer_hops: null,
        max_input_tokens: null,
        max_output_tokens: null,
        precount: false,
      },
      'test',
    );
    await runWithContext(fakeCtx(), async () => {
      const ok = await wrapped[0]!.executor.execute({ text: 'hi' });
      expect(ok).toBe('hi');
      const blocked = await wrapped[0]!.executor.execute({ text: 'hi' });
      expect(content(blocked)).toContain('[limit exceeded] max_tool_calls');
      // The marker is what lets outer post-call wrappers (e.g. guardrails
      // output filter) recognise an inner deny and skip rather than
      // re-processing a deny string as if it were tool output.
      expect(isWrapperDeny(blocked)).toBe(true);
    });
  });

  it('returns the input list when no limits set', () => {
    const out = applyLimits(
      [echo],
      {
        max_tool_calls: null,
        max_wall_clock_seconds: null,
        max_peer_hops: null,
        max_input_tokens: null,
        max_output_tokens: null,
        precount: false,
      },
      'test',
    );
    expect(out[0]).toBe(echo);
  });
});

describe('policy wrapper', () => {
  it('denies when principal lacks required scope', async () => {
    const wrapped = applyPolicies(
      [echo],
      [{ id: 'p1', description: '', required_scopes: ['write:thing'], tools: ['echo'] }],
      'test',
    );
    await runWithContext(fakeCtx(), async () => {
      const out = await wrapped[0]!.executor.execute({ text: 'hi' });
      expect(content(out)).toContain('[policy denied]');
    });
  });

  it('passes when principal has required scope', async () => {
    const wrapped = applyPolicies(
      [echo],
      [{ id: 'p1', description: '', required_scopes: ['x'], tools: ['echo'] }],
      'test',
    );
    const ctx: RequestContext = {
      env: fakeEnv(),
      auth: { ...ANONYMOUS, principal: { ...ANONYMOUS.principal, scopes: ['x'] } },
      limitState: newLimitState(),
    };
    await runWithContext(ctx, async () => {
      const out = await wrapped[0]!.executor.execute({ text: 'hi' });
      expect(out).toBe('hi');
    });
  });
});

describe('defineTool arg parsing', () => {
  it('returns an invalid-args error when args fail Zod parse', async () => {
    const out = await echo.executor.execute({ wrong: 1 } as Record<string, unknown>);
    expect(content(out)).toContain('[invalid args for echo]');
  });

  it('strips unknown keys before handing args to the handler when schema is .strict()', async () => {
    const strict = defineTool({
      name: 'strict-tool',
      description: '',
      args: z.object({ a: z.string() }).strict(),
      async handler(args) {
        // Verify the handler never sees the extra key.
        return JSON.stringify(args);
      },
    });
    const out = await strict.executor.execute({ a: 'hi', extra: 'nope' } as Record<
      string,
      unknown
    >);
    expect(content(out)).toContain('[invalid args for strict-tool]');
  });
});
