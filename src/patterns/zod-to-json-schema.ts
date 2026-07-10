/**
 * Zod -> JSON Schema for tool input declarations.
 *
 * Zod v4 ships `z.toJSONSchema()` natively, so we no longer need a
 * hand-rolled converter. We re-export a stable function name so the rest
 * of the runtime doesn't care about the upstream API. `target: 'draft-7'`
 * keeps the output compatible with Anthropic's tool-calling spec
 * (Anthropic rejects `$schema` and `$defs` from draft-2020-12 unless the
 * payload is otherwise legal).
 */

import { z } from 'zod';
import type { Tool } from '../tools/types';

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
}

/**
 * Resolve the JSON Schema to advertise for a tool's input. Prefers
 * `tool.rawInputSchema` when present (remote MCP tools that arrive with a
 * JSON Schema already), otherwise compiles the local Zod `args`.
 */
export function getToolInputSchema(tool: Tool): Record<string, unknown> {
  return tool.rawInputSchema ?? zodToJsonSchema(tool.args);
}
