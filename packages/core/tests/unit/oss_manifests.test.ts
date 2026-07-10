/**
 * The bundled OSS / hybrid demo manifests parse, pass cross-field validation,
 * and compile through `buildAgent` against Workers-AI + hybrid model routes.
 *
 *   - oss-only      → react on a Workers AI route (no Anthropic/OpenAI keys)
 *   - oss-fast      → react on a smaller Workers AI route, tool-free
 *   - hybrid-router → router whose classifier is Claude, sub-agents are OSS
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Env } from '../../src/env';
import { buildAgent } from '../../src/manifests/builder';
import { ManifestSchema } from '../../src/manifests/schema';
import { validateManifest } from '../../src/manifests/validate';
import type { Agent } from '../../src/patterns/types';
import { InMemoryToolProvider } from '../../src/tools/provider';
import { defineTool } from '../../src/tools/types';

const MANIFEST_DIR = join(__dirname, '../../manifests');

function loadManifestYaml(name: string): unknown {
  return parseYaml(readFileSync(join(MANIFEST_DIR, `${name}.yaml`), 'utf8'));
}

// Routes the demo manifests reference. Mirrors DEFAULT_MODEL_ROUTES in env.ts.
function fakeEnv(): Env {
  return {
    MODEL_ROUTES: JSON.stringify({
      'llama-3-fast': { provider: 'workers-ai', model: '@cf/meta/llama-3.1-8b-instruct' },
      'llama-3-pro': { provider: 'workers-ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
      'claude-haiku-4': { provider: 'anthropic', model: 'claude-haiku-4-5' },
    }),
    DEFAULT_MODEL_ID: 'llama-3-pro',
    ENVIRONMENT: 'development',
  } as unknown as Env;
}

function stubProvider(): InMemoryToolProvider {
  const tool = (name: string) =>
    defineTool({ name, description: name, args: z.object({}), handler: async () => 'ok' });
  return new InMemoryToolProvider({
    calculator: () => tool('calculator'),
    list_skills: () => tool('list_skills'),
    activate_skill: () => tool('activate_skill'),
    deactivate_skill: () => tool('deactivate_skill'),
  });
}

function fakeSubAgent(name: string): Agent {
  return {
    tools: [],
    pattern: 'react',
    manifestId: name,
    manifestVersion: '1.0.0',
    invoke: async () => ({ messages: [], final: { role: 'assistant', content: '' } }),
    async *streamEvents() {},
  };
}

describe('OSS / hybrid demo manifests', () => {
  for (const name of ['oss-only', 'oss-fast', 'hybrid-router']) {
    it(`${name} parses and passes cross-field validation`, () => {
      const manifest = ManifestSchema.parse(loadManifestYaml(name));
      expect(() => validateManifest(manifest)).not.toThrow();
    });
  }

  it('oss-only compiles to a react agent on a Workers AI route', async () => {
    const manifest = ManifestSchema.parse(loadManifestYaml('oss-only'));
    const agent = await buildAgent(manifest, { env: fakeEnv(), tools: stubProvider() });
    expect(agent.pattern).toBe('react');
    expect(agent.manifestId).toBe('oss-only');
    // calculator + skills tools survive the governance wrappers.
    expect(agent.tools.map((t) => t.name)).toContain('calculator');
  });

  it('oss-fast compiles to a tool-free react agent', async () => {
    const manifest = ManifestSchema.parse(loadManifestYaml('oss-fast'));
    const agent = await buildAgent(manifest, { env: fakeEnv(), tools: stubProvider() });
    expect(agent.pattern).toBe('react');
    expect(agent.tools).toHaveLength(0);
  });

  it('hybrid-router compiles with a Claude classifier and OSS sub-agents', async () => {
    const manifest = ManifestSchema.parse(loadManifestYaml('hybrid-router'));
    const built: string[] = [];
    const agent = await buildAgent(manifest, {
      env: fakeEnv(),
      tools: stubProvider(),
      subAgentBuilder: async (subName: string) => {
        built.push(subName);
        return fakeSubAgent(subName);
      },
    });
    expect(agent.pattern).toBe('router');
    expect(built.sort()).toEqual(['oss-fast', 'oss-only']);
  });
});
