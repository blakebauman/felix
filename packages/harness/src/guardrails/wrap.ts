/**
 * Wrap tools with input/output content filters.
 *
 * Filters mutate string-typed inputs and string outputs; non-string values
 * pass through. When `block_on_match: true`, a match short-circuits with a
 * deny string instead of redacting. Matches are recorded as audit events
 * with content fingerprints — never the raw matched text.
 */

import { recordEvent } from '../audit/store';
import { currentTenantSubject } from '../limits/state';
import { recordCounter } from '../observability/metrics';
import { wrapExecutor } from '../tools/executor';
import { denyOutput, isWrapperDeny, type Tool, type ToolInput } from '../tools/types';
import { type Guardrails, guardrailsEnabled } from './models';
import { type FilterResult, runFilters } from './pipeline';

function recordBlock(opts: {
  manifestId: string;
  toolName: string;
  transport: string;
  surface: 'input' | 'output';
  matches: FilterResult['matches'];
}): void {
  const { tenantId, subject } = currentTenantSubject();
  recordEvent({
    tenantId,
    eventType: 'guardrail_block',
    principalSubject: subject,
    manifestId: opts.manifestId,
    status: opts.matches.length ? 'matched' : 'clean',
    payload: {
      tool: opts.toolName,
      transport: opts.transport,
      surface: opts.surface,
      matches: opts.matches,
    },
  });
  recordCounter('orchestrator_guardrail_blocks', {
    surface: opts.surface,
    manifest_id: opts.manifestId,
    transport: opts.transport,
  });
}

function isStringTool(value: unknown): value is string {
  return typeof value === 'string';
}

function wrapOne(inner: Tool, g: Guardrails, manifestId: string): Tool {
  const filterInput = g.targets.includes('input');
  const filterOutput = g.targets.includes('output');
  return {
    ...inner,
    executor: wrapExecutor(inner.executor, async (args, ctx) => {
      const workingArgs: ToolInput = { ...args };
      if (filterInput) {
        for (const [k, v] of Object.entries(workingArgs)) {
          if (!isStringTool(v)) continue;
          const r = await runFilters(g.providers, v);
          if (r.matches.length > 0) {
            recordBlock({
              manifestId,
              toolName: inner.name,
              transport: inner.executor.transport,
              surface: 'input',
              matches: r.matches,
            });
            if (g.block_on_match) {
              return denyOutput(
                `[guardrail blocked] tool '${inner.name}' input field '${k}' contained disallowed content`,
                'guardrails',
              );
            }
            workingArgs[k] = r.filtered;
          }
        }
      }

      const out = await inner.executor.execute(workingArgs, ctx);
      if (!filterOutput) return out;
      // Inner wrapper already denied — pass through verbatim. Filtering a
      // deny string would either redact policy/limit/approval messages
      // (confusing the model) or generate a duplicate guardrail event for
      // content the user never produced.
      if (isWrapperDeny(out)) return out;

      const outString = typeof out === 'string' ? out : out.content;
      const r = await runFilters(g.providers, outString);
      if (r.matches.length > 0) {
        recordBlock({
          manifestId,
          toolName: inner.name,
          transport: inner.executor.transport,
          surface: 'output',
          matches: r.matches,
        });
        if (g.block_on_match) {
          return denyOutput(
            `[guardrail blocked] tool '${inner.name}' output contained disallowed content`,
            'guardrails',
          );
        }
        return typeof out === 'string'
          ? r.filtered
          : { content: r.filtered, metadata: out.metadata };
      }
      return out;
    }),
  };
}

export function applyGuardrails(tools: Tool[], g: Guardrails, manifestId: string): Tool[] {
  if (!guardrailsEnabled(g)) return [...tools];
  return tools.map((t) => wrapOne(t, g, manifestId));
}
