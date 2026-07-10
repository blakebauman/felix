/**
 * The ToolExecutor seam: every Tool carries a `transport`-labelled
 * executor. `defineTool` wraps a local handler; `defineToolWithExecutor`
 * lets MCP / A2A / future container transports own their own executor.
 * Governance wrappers replace `tool.executor` while preserving the inner
 * transport label.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../../src/context';
import type { Env } from '../../../src/env';
import { applyLimits } from '../../../src/limits/wrap';
import { readToolErrorCode, toolOutputContent } from '../../../src/tools/errors';
import { localExecutor, type ToolExecutor } from '../../../src/tools/executor';
import { defineTool, defineToolWithExecutor } from '../../../src/tools/types';

function ctx(): RequestContext {
  return { env: {} as Env, auth: ANONYMOUS, limitState: newLimitState() };
}

describe('ToolExecutor seam', () => {
  it('defineTool produces a transport=local executor that parses args', async () => {
    const tool = defineTool({
      name: 'add',
      description: 'add two numbers',
      args: z.object({ a: z.number(), b: z.number() }),
      handler: async ({ a, b }) => String(a + b),
    });
    expect(tool.executor.transport).toBe('local');
    expect(await tool.executor.execute({ a: 2, b: 3 })).toBe('5');
    // Invalid args produce a recoverable error output (no throw)
    const bad = await tool.executor.execute({ a: 'wat' } as unknown as Record<string, unknown>);
    expect(toolOutputContent(bad)).toContain('[invalid args for add]');
    expect(readToolErrorCode(bad)).toBe('invalid_arguments');
  });

  it('defineToolWithExecutor preserves a caller-supplied transport label', async () => {
    const remote: ToolExecutor = {
      transport: 'fake-remote',
      async execute(args) {
        return `remote saw: ${JSON.stringify(args)}`;
      },
    };
    const tool = defineToolWithExecutor({
      name: 'remote',
      description: 'remote tool',
      args: z.object({ x: z.string() }),
      executor: remote,
    });
    expect(tool.executor.transport).toBe('fake-remote');
    expect(await tool.executor.execute({ x: 'hi' })).toBe('remote saw: {"x":"hi"}');
  });

  it('governance wrappers preserve the inner transport label', async () => {
    const remote: ToolExecutor = {
      transport: 'fake-remote',
      async execute() {
        return 'ok';
      },
    };
    const tool = defineToolWithExecutor({
      name: 'remote',
      description: '',
      args: z.object({}),
      executor: remote,
    });
    const [wrapped] = applyLimits(
      [tool],
      {
        max_tool_calls: 5,
        max_wall_clock_seconds: null,
        max_peer_hops: null,
        max_input_tokens: null,
        max_output_tokens: null,
        precount: false,
      },
      'm',
    );
    expect(wrapped!.executor.transport).toBe('fake-remote');
    const out = await runWithContext(ctx(), async () =>
      wrapped!.executor.execute({}, { manifestId: 'm' }),
    );
    expect(out).toBe('ok');
  });

  it('localExecutor wraps a bare async function', async () => {
    const ex = localExecutor(async (args) => `local: ${JSON.stringify(args)}`);
    expect(ex.transport).toBe('local');
    expect(await ex.execute({ x: 1 })).toBe('local: {"x":1}');
  });

  it('an executor throw surfaces to the caller (caller stringifies for the model)', async () => {
    const fatal: ToolExecutor = {
      transport: 'fake',
      async execute() {
        throw new Error('boom');
      },
    };
    const tool = defineToolWithExecutor({
      name: 'fatal',
      description: '',
      args: z.object({}),
      executor: fatal,
    });
    await expect(tool.executor.execute({})).rejects.toThrow('boom');
  });
});
