/**
 * JIT tool retrieval. `selectTopKTools` filters the tool
 * list to the K most relevant by BGE cosine similarity to the recent
 * conversation.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS } from '../../src/auth/context';
import { newLimitState, type RequestContext, runWithContext } from '../../src/context';
import type { Env } from '../../src/env';
import { _clearToolEmbeddingCache, selectTopKTools } from '../../src/tools/retrieval';
import { defineToolWithExecutor, type Tool } from '../../src/tools/types';

function fakeTool(name: string, description: string): Tool {
  return defineToolWithExecutor({
    name,
    description,
    args: z.object({}),
    executor: {
      transport: 'local',
      async execute() {
        return '';
      },
    },
  });
}

/** Same embedding stub pattern as the semantic strategy tests: vector
 *  with 'a' count in the first component. */
function aiStub() {
  return {
    async run(_model: string, input: { text: string[] }) {
      return {
        data: input.text.map((t) => [(t.match(/a/g) ?? []).length, 1, 0]),
      };
    },
  };
}

function makeCtx(env: Env): RequestContext {
  return { env, auth: ANONYMOUS, limitState: newLimitState() };
}

afterEach(() => {
  _clearToolEmbeddingCache();
});

describe('selectTopKTools', () => {
  const tools = [
    fakeTool('alpha', 'aaaaaa describes alpha'),
    fakeTool('beta', 'no relevant letters'),
    fakeTool('gamma', 'aa some letters'),
    fakeTool('delta', 'this tool is unrelated'),
  ];

  it('passes through when retrieval is disabled', async () => {
    const filtered = await selectTopKTools(tools, [{ role: 'user', content: 'q' }], {
      enabled: false,
      top_k: 2,
    });
    expect(filtered).toEqual(tools);
  });

  it('passes through when top_k >= tools.length (no point filtering)', async () => {
    const filtered = await selectTopKTools(tools, [{ role: 'user', content: 'q' }], {
      enabled: true,
      top_k: 10,
    });
    expect(filtered).toEqual(tools);
  });

  it('passes through when env.AI is absent', async () => {
    const env = {} as unknown as Env;
    const filtered = await runWithContext(makeCtx(env), () =>
      selectTopKTools(tools, [{ role: 'user', content: 'q' }], { enabled: true, top_k: 2 }),
    );
    expect(filtered).toEqual(tools);
  });

  it('filters to top-K by cosine similarity when AI is wired', async () => {
    const env = { AI: aiStub() } as unknown as Env;
    const filtered = await runWithContext(makeCtx(env), () =>
      selectTopKTools(tools, [{ role: 'user', content: 'aaaaaa' }], { enabled: true, top_k: 2 }),
    );
    expect(filtered.map((t) => t.name).sort()).toEqual(['alpha', 'gamma']);
  });

  it('returns tools in score order (highest first)', async () => {
    const env = { AI: aiStub() } as unknown as Env;
    const filtered = await runWithContext(makeCtx(env), () =>
      selectTopKTools(tools, [{ role: 'user', content: 'aaaaaa' }], { enabled: true, top_k: 3 }),
    );
    expect(filtered[0]!.name).toBe('alpha'); // a-count 6
    expect(filtered[1]!.name).toBe('gamma'); // a-count 2
  });

  it('passes through when the query is empty', async () => {
    const env = { AI: aiStub() } as unknown as Env;
    const filtered = await runWithContext(makeCtx(env), () =>
      selectTopKTools(tools, [{ role: 'user', content: '' }], { enabled: true, top_k: 2 }),
    );
    expect(filtered).toEqual(tools);
  });
});
