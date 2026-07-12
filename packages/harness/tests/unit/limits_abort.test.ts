/**
 * Cancellation through ToolInvocationCtx.signal:
 *
 *   - the limits wrapper arms a wall-clock timer that aborts mid-flight,
 *   - tools see the same signal whether or not limits is configured (the
 *     react loop injects it from the request-scoped LimitState),
 *   - disposeLimitState fires abort and clears the timer.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../../src/auth/context';
import {
  disposeLimitState,
  newLimitState,
  type RequestContext,
  runWithContext,
} from '../../src/context';
import type { Env } from '../../src/env';
import { ABSOLUTE_LIMITS, clampLimits, DEFAULT_LIMITS } from '../../src/limits/models';
import { applyLimits } from '../../src/limits/wrap';
import { defineTool } from '../../src/tools/types';

describe('clampLimits (defense-in-depth ceiling)', () => {
  it('clamps a non-null cap above the ceiling down to it', () => {
    const clamped = clampLimits({
      ...DEFAULT_LIMITS,
      max_tool_calls: 1_000_000,
      max_input_tokens: 9_000_000_000,
    });
    expect(clamped.max_tool_calls).toBe(ABSOLUTE_LIMITS.max_tool_calls);
    expect(clamped.max_input_tokens).toBe(ABSOLUTE_LIMITS.max_input_tokens);
  });

  it('preserves null (no manifest cap) and in-range values', () => {
    const clamped = clampLimits({ ...DEFAULT_LIMITS, max_tool_calls: null, max_peer_hops: 2 });
    expect(clamped.max_tool_calls).toBeNull();
    expect(clamped.max_peer_hops).toBe(2);
  });
});

function fakeCtx(): RequestContext {
  return { env: {} as unknown as Env, auth: ANONYMOUS, limitState: newLimitState() };
}

const seesSignal = defineTool({
  name: 'sees-signal',
  description: 'reports whether it received an AbortSignal',
  args: z.object({}),
  handler: async (_args, ctx) => {
    return ctx?.signal ? 'has-signal' : 'no-signal';
  },
});

describe('abort signal plumbing', () => {
  it('the limits wrapper injects the request abort signal into the ctx', async () => {
    const wrapped = applyLimits(
      [seesSignal],
      {
        max_tool_calls: 5,
        max_wall_clock_seconds: 60,
        max_peer_hops: null,
        max_input_tokens: null,
        max_output_tokens: null,
        precount: false,
      },
      'm',
    );
    const out = await runWithContext(fakeCtx(), async () =>
      wrapped[0]!.executor.execute({}, { manifestId: 'm' }),
    );
    expect(out).toBe('has-signal');
  });

  it('disposeLimitState fires the abort signal', async () => {
    const state = newLimitState();
    expect(state.abortController.signal.aborted).toBe(false);
    disposeLimitState(state);
    expect(state.abortController.signal.aborted).toBe(true);
  });

  it('arms a wall-clock timer that aborts the controller', async () => {
    const state = newLimitState();
    state.startedAt = Date.now() - 1000; // pretend we're already 1s in
    const ctx: RequestContext = { env: {} as unknown as Env, auth: ANONYMOUS, limitState: state };
    const wrapped = applyLimits(
      [seesSignal],
      // Cap is 0 seconds; armWallClockAbort should fire immediately on
      // first call because remainingMs <= 0.
      {
        max_tool_calls: null,
        max_wall_clock_seconds: 0,
        max_peer_hops: null,
        max_input_tokens: null,
        max_output_tokens: null,
        precount: false,
      },
      'm',
    );
    await runWithContext(ctx, async () => {
      // Trigger arming. The wall-clock check in the wrapper itself returns
      // a deny string (we're past budget); side-effect we care about is
      // that abort fired so future fetches would cancel.
      await wrapped[0]!.executor.execute({}, { manifestId: 'm' });
    });
    expect(state.abortController.signal.aborted).toBe(true);
  });
});
