/**
 * SKILL.md loader.
 *
 * Each skill is bundled at build time as a `SKILL.md` blob; YAML frontmatter
 * encodes the SkillSpec (tools, mcp_servers, peers, version) and the body
 * is appended to the agent's system prompt at build time.
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { BUNDLED_SKILL_NAMES, BUNDLED_SKILLS } from './bundled';

export const SkillSpecSchema = z
  .object({
    name: z.string(),
    version: z.string().default('1.0.0'),
    description: z.string().default(''),
    tools: z.array(z.string()).default([]),
    mcp_servers: z.array(z.string()).default([]),
    peers: z.array(z.string()).default([]),
  })
  .strict()
  .partial({ description: true, tools: true, mcp_servers: true, peers: true, version: true });

export type SkillSpec = z.infer<typeof SkillSpecSchema>;

interface ParsedSkill {
  spec: SkillSpec;
  body: string;
}

const cache = new Map<string, ParsedSkill>();

function parse(raw: string, name: string): ParsedSkill {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fmMatch) {
    const frontmatter = parseYaml(fmMatch[1]!) ?? {};
    const body = fmMatch[2] ?? '';
    return { spec: SkillSpecSchema.parse({ name, ...(frontmatter as object) }), body };
  }
  return { spec: SkillSpecSchema.parse({ name }), body: raw };
}

function load(name: string): ParsedSkill | undefined {
  const cached = cache.get(name);
  if (cached) return cached;
  const raw = BUNDLED_SKILLS[name];
  if (!raw) return undefined;
  const parsed = parse(raw, name);
  cache.set(name, parsed);
  return parsed;
}

export function getSkillMeta(name: string): SkillSpec | undefined {
  return load(name)?.spec;
}

export function loadSkillBody(name: string): string {
  return load(name)?.body ?? '';
}

export function listSkills(): string[] {
  return [...BUNDLED_SKILL_NAMES];
}
