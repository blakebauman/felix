/**
 * Wrapper-level tests: tool selection, argument harvesting, the deny path, and
 * the fail-closed guard. The `require_approval` path needs the approvals store
 * (Postgres + ApprovalsDO) and lives in
 * `apps/api/tests/integration/command_screening.test.ts`; here we assert the
 * decision that leads into it, not the persistence.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { type CommandScreening, DEFAULT_COMMAND_SCREENING } from '../../src/policy/command-models';
import {
  applyCommandScreening,
  collectCommandArgs,
  screensTool,
} from '../../src/policy/command-wrap';
import type { ToolExecutor } from '../../src/tools/executor';
import {
  defineTool,
  defineToolWithExecutor,
  isWrapperDeny,
  type Tool,
  type ToolOutput,
} from '../../src/tools/types';

function content(out: ToolOutput): string {
  return typeof out === 'string' ? out : out.content;
}

function fakeCtx(): RequestContext {
  return { env: {} as unknown as Env, auth: ANONYMOUS, limitState: newLimitState() };
}

const screening = (over: Partial<CommandScreening> = {}): CommandScreening => ({
  ...DEFAULT_COMMAND_SCREENING,
  enabled: true,
  ...over,
});

/** A tool on a command-executing transport, recording whether it actually ran. */
function sandboxTool(name = 'sandbox_exec'): { tool: Tool; ran: () => boolean } {
  let executed = false;
  const executor: ToolExecutor = {
    transport: 'sandbox',
    async execute() {
      executed = true;
      return 'ran';
    },
  };
  return {
    tool: defineToolWithExecutor({
      name,
      description: 'run a command',
      args: z.object({}).passthrough(),
      executor,
    }),
    ran: () => executed,
  };
}

const localTool = defineTool({
  name: 'lookup',
  description: 'local tool',
  args: z.object({ query: z.string() }),
  async handler({ query }) {
    return query;
  },
});

describe('tool selection', () => {
  it('screens sandbox and container transports by default', () => {
    const config = screening();
    expect(screensTool(sandboxTool().tool, config)).toBe(true);
    expect(screensTool(localTool, config)).toBe(false);
  });

  it('honors explicit tool patterns including a trailing wildcard', () => {
    const config = screening({ tools: ['lookup', 'shell_*'] });
    expect(screensTool(localTool, config)).toBe(true);
    expect(screensTool(sandboxTool('shell_run').tool, config)).toBe(true);
    expect(screensTool(sandboxTool('other_exec').tool, config)).toBe(false);
  });

  it('leaves every tool untouched when disabled', () => {
    const { tool } = sandboxTool();
    const [wrapped] = applyCommandScreening([tool], DEFAULT_COMMAND_SCREENING, 'm');
    expect(wrapped).toBe(tool);
  });

  it('preserves the inner transport label through the wrap', () => {
    const { tool } = sandboxTool();
    const [wrapped] = applyCommandScreening([tool], screening(), 'm');
    expect(wrapped!.executor.transport).toBe('sandbox');
  });
});

describe('collectCommandArgs', () => {
  it('collects every string when no arg names are configured', () => {
    const found = collectCommandArgs({ command: 'ls', note: 'hello' }, []);
    expect(found.map((f) => f.value).sort()).toEqual(['hello', 'ls']);
  });

  it('collects strings nested in arrays', () => {
    const found = collectCommandArgs({ argv: ['-c', 'rm -rf /'] }, []);
    expect(found.map((f) => f.value)).toContain('rm -rf /');
  });

  it('restricts to the configured arg names at any depth', () => {
    const found = collectCommandArgs(
      { command: 'rm -rf /', note: 'ignore me', opts: { command: 'nested' } },
      ['command'],
    );
    expect(found.map((f) => f.value).sort()).toEqual(['nested', 'rm -rf /']);
  });

  it('reports the path that produced each value', () => {
    const found = collectCommandArgs({ argv: ['rm -rf /'] }, []);
    expect(found[0]!.path).toBe('argv[0]');
  });

  it('ignores non-string leaves and blank strings', () => {
    expect(collectCommandArgs({ n: 5, ok: true, blank: '   ' }, [])).toEqual([]);
  });

  it('stops at the depth cap rather than recursing unboundedly', () => {
    let deep: unknown = 'rm -rf /';
    for (let i = 0; i < 12; i++) deep = { nest: deep };
    expect(collectCommandArgs(deep, [])).toEqual([]);
  });
});

describe('deny path', () => {
  it('denies a matched command and never runs the tool', async () => {
    const { tool, ran } = sandboxTool();
    const config = screening({
      include_defaults: false,
      rules: [{ pattern: '\\bmkfs\\b', decision: 'deny', reason: 'filesystem format' }],
    });
    const [wrapped] = applyCommandScreening([tool], config, 'm');

    const out = await runWithContext(fakeCtx(), () =>
      wrapped!.executor.execute({ command: 'mkfs.ext4 /dev/sda1' }),
    );

    expect(isWrapperDeny(out)).toBe(true);
    expect(content(out)).toContain('[command denied]');
    expect(content(out)).toContain('filesystem format');
    expect(ran()).toBe(false);
  });

  it('denies through an evasion rewrite', async () => {
    const { tool, ran } = sandboxTool();
    const config = screening({
      include_defaults: false,
      rules: [{ pattern: '\\bmkfs\\b', decision: 'deny' }],
    });
    const [wrapped] = applyCommandScreening([tool], config, 'm');

    const out = await runWithContext(fakeCtx(), () =>
      wrapped!.executor.execute({ command: 'bash -c \'mk"f"s.ext4 /dev/sda1\'' }),
    );

    expect(isWrapperDeny(out)).toBe(true);
    expect(ran()).toBe(false);
  });

  it('runs the tool when nothing matches', async () => {
    const { tool, ran } = sandboxTool();
    const [wrapped] = applyCommandScreening([tool], screening(), 'm');

    const out = await runWithContext(fakeCtx(), () =>
      wrapped!.executor.execute({ command: 'ls -la' }),
    );

    expect(content(out)).toBe('ran');
    expect(ran()).toBe(true);
  });

  it('lets a deny in a later argument win over an earlier approval match', async () => {
    const { tool, ran } = sandboxTool();
    const config = screening({
      include_defaults: false,
      rules: [
        { pattern: '\\brm\\b.*-rf', decision: 'require_approval', reason: 'recursive delete' },
        { pattern: '\\bmkfs\\b', decision: 'deny', reason: 'filesystem format' },
      ],
    });
    const [wrapped] = applyCommandScreening([tool], config, 'm');

    const out = await runWithContext(fakeCtx(), () =>
      wrapped!.executor.execute({ argv: ['rm -rf /tmp/x', 'mkfs.ext4 /dev/sda1'] }),
    );

    expect(content(out)).toContain('[command denied]');
    expect(ran()).toBe(false);
  });
});

describe('fail-closed guards', () => {
  it('denies when no request context is installed', async () => {
    const { tool, ran } = sandboxTool();
    const [wrapped] = applyCommandScreening([tool], screening(), 'm');

    const out = await wrapped!.executor.execute({ command: 'ls -la' });

    expect(isWrapperDeny(out)).toBe(true);
    expect(content(out)).toContain('[command screening unavailable]');
    expect(ran()).toBe(false);
  });

  it('denies an unmatched command under allowlist mode', async () => {
    const { tool, ran } = sandboxTool();
    const config = screening({
      mode: 'allowlist',
      include_defaults: false,
      rules: [{ pattern: '^ls\\b', decision: 'allow' }],
    });
    const [wrapped] = applyCommandScreening([tool], config, 'm');

    const out = await runWithContext(fakeCtx(), () =>
      wrapped!.executor.execute({ command: 'cat /etc/passwd' }),
    );

    expect(isWrapperDeny(out)).toBe(true);
    expect(ran()).toBe(false);
  });
});
