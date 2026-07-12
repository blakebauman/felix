/**
 * `applyApprovals` fail-closed contract: an approval-gated tool must NOT run
 * when there is no RequestContext to verify a decision against. This path is
 * unreachable via HTTP / the durable Workflow (both install a context), but a
 * future non-request invoker that forgets `runWithContext` must not silently
 * bypass the human gate.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApprovalRule } from '../../src/approvals/models';
import { applyApprovals } from '../../src/approvals/wrap';
import { defineTool, isWrapperDeny } from '../../src/tools/types';

const dangerous = defineTool({
  name: 'delete_everything',
  description: 'irreversible',
  args: z.object({ target: z.string() }),
  async handler({ target }) {
    return `deleted ${target}`;
  },
});

const rule: ApprovalRule = { id: 'r1', tools: ['delete_everything'] } as ApprovalRule;

describe('applyApprovals without a RequestContext', () => {
  it('denies (fails closed) instead of executing the gated tool', async () => {
    const [wrapped] = applyApprovals([dangerous], [rule], 'm');
    // No runWithContext — getContext() returns undefined inside the wrapper.
    const out = await wrapped!.executor.execute({ target: 'prod-db' });
    expect(isWrapperDeny(out)).toBe(true);
    const content = typeof out === 'string' ? out : out.content;
    expect(content).toMatch(/approval unavailable/i);
    // Crucially, the inner tool never ran.
    expect(content).not.toContain('deleted');
  });
});

describe('applyApprovals tool targeting', () => {
  it('gates an MCP-named tool via a `server__*` prefix glob', async () => {
    // The manifest can't know what the `stripe` server names its tools; a
    // `stripe__*` rule must gate whatever it presents (server can't dodge by
    // renaming). Wrapped == not the same object as the input tool.
    const mcpTool = defineTool({
      name: 'stripe__evil_renamed_charge',
      description: 'remote mcp tool',
      args: z.object({ x: z.string() }),
      async handler() {
        return 'ran';
      },
    });
    const prefixRule: ApprovalRule = { id: 'r2', tools: ['stripe__*'] } as ApprovalRule;
    const [wrapped] = applyApprovals([mcpTool], [prefixRule], 'm');
    expect(wrapped).not.toBe(mcpTool); // it was wrapped (gated)

    const unrelated = defineTool({
      name: 'notion__read',
      description: 'x',
      args: z.object({ x: z.string() }),
      async handler() {
        return 'ran';
      },
    });
    const [passthrough] = applyApprovals([unrelated], [prefixRule], 'm');
    expect(passthrough).toBe(unrelated); // not gated — different server prefix
  });
});
