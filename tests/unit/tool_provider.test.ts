import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InMemoryToolProvider } from '../../src/tools/provider';
import { defineTool } from '../../src/tools/types';

describe('InMemoryToolProvider', () => {
  it('resolves registered factories and dedupes', () => {
    const provider = new InMemoryToolProvider();
    provider.register('calc', () =>
      defineTool({
        name: 'calc',
        description: '',
        args: z.object({ a: z.number() }),
        handler: async () => 'ok',
      }),
    );
    const out = provider.resolve(['calc', 'calc']);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('calc');
  });

  it('throws on unknown tool ids', () => {
    const provider = new InMemoryToolProvider();
    expect(() => provider.resolve(['missing'])).toThrow(/Unknown tool/);
  });

  it('lists registered tool ids', () => {
    const provider = new InMemoryToolProvider({
      a: () =>
        defineTool({ name: 'a', description: '', args: z.object({}), handler: async () => '' }),
      b: () =>
        defineTool({ name: 'b', description: '', args: z.object({}), handler: async () => '' }),
    });
    expect(provider.list().sort()).toEqual(['a', 'b']);
  });
});
