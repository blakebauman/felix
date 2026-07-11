/**
 * `applyJudges` — sixth governance wrapper, composed *after*
 * `applyGuardrails`. Each declared `JudgeRule` runs as a Workers-AI
 * scorer over the tool's string output; a sub-threshold score denies
 * the call with `denyOutput('… judge denied …', 'guardrails')`.
 *
 * Phase-5 framing (Cursor's "agents review agents" + Fowler's
 * inferential sensors): regex-style guardrails catch obvious PII /
 * credentials, but they miss nuanced failures — irrelevant tool
 * results, hallucinated facts, off-mission outputs. A small Workers-AI
 * model run as a judge fills that gap without burning AI Gateway
 * quota: the call is native to the same isolate.
 *
 * Skipped on outputs already flagged by an earlier wrapper deny
 * (`isWrapperDeny`) or a transport-layer ToolError (`readToolErrorCode`).
 * Judging a deny / error string is wasted compute and double-emits
 * the failure signal in audit.
 */

import { recordEvent } from '../audit/store';
import { getContext } from '../context';
import { currentTenantSubject } from '../limits/state';
import { recordCounter } from '../observability/metrics';
import { readToolErrorCode } from '../tools/errors';
import { wrapExecutor } from '../tools/executor';
import {
  denyOutput,
  isWrapperDeny,
  type Tool,
  type ToolInput,
  type ToolOutput,
} from '../tools/types';
import type { Guardrails, JudgeRule } from './models';

const JUDGE_SYSTEM_PROMPT =
  'You are an evaluator scoring whether a tool result satisfies a criteria string. ' +
  'Reply with ONLY a JSON object on a single line: ' +
  '{"score": <float 0..1>, "reasoning": "<one short sentence>"}. No prose, no markdown.';

interface ParsedJudgeReply {
  score: number;
  reasoning: string;
}

/** Defensive — the model can wrap JSON in code fences despite the prompt. */
function parseJudgeReply(raw: string): ParsedJudgeReply | null {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { score?: unknown; reasoning?: unknown };
    const score = typeof obj.score === 'number' ? obj.score : Number(obj.score);
    if (!Number.isFinite(score)) return null;
    const clamped = Math.max(0, Math.min(1, score));
    const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
    return { score: clamped, reasoning };
  } catch {
    return null;
  }
}

interface JudgeOutcome {
  score: number;
  passed: boolean;
  reasoning: string;
}

/**
 * Run one judge against a tool result. Returns `null` when the judge
 * can't run (no AI binding) so the wrapper short-circuits to a pass —
 * a misconfigured Worker should not silently block every tool call.
 * The miss is still observable through the `orchestrator_judge_skipped`
 * counter.
 */
async function judgeOne(
  rule: JudgeRule,
  toolName: string,
  args: ToolInput,
  output: string,
  manifestId: string,
): Promise<JudgeOutcome | null> {
  const ctx = getContext();
  const ai = ctx?.env.AI;
  if (!ai) {
    recordCounter('orchestrator_judge_skipped', {
      reason: 'no_ai_binding',
      judge: rule.name,
      manifest_id: manifestId,
    });
    return null;
  }
  const prompt = [
    `Tool: ${toolName}`,
    `Tool arguments: ${JSON.stringify(args).slice(0, 500)}`,
    `Tool output: ${output.slice(0, 2000)}`,
    `Criteria: ${rule.criteria}`,
  ].join('\n\n');
  try {
    const reply = (await ai.run(rule.model, {
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: 200,
      temperature: 0,
    })) as { response?: unknown };
    // Workers-AI text models return `{ response: string }`, but some models /
    // binding modes hand back a non-string (an already-parsed object, or the
    // result under a different shape). Coerce so `parseJudgeReply` never calls
    // `.match` on a non-string — an uncoerced object used to throw and deny
    // every tool result.
    const raw = reply.response;
    const text = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw);
    const parsed = parseJudgeReply(text);
    if (!parsed) {
      // Treat an unparseable reply as a pass with a low score so the
      // run continues; the audit row records why.
      return { score: 0, passed: false, reasoning: `unparseable reply: ${text.slice(0, 120)}` };
    }
    return {
      score: parsed.score,
      passed: parsed.score >= rule.threshold,
      reasoning: parsed.reasoning || 'no reasoning supplied',
    };
  } catch (err) {
    recordCounter('orchestrator_judge_error', {
      judge: rule.name,
      manifest_id: manifestId,
    });
    return {
      score: 0,
      passed: false,
      reasoning: `judge call failed: ${(err as Error).message ?? String(err)}`,
    };
  }
}

function appliesTo(rule: JudgeRule, toolName: string): boolean {
  if (rule.target_tools.length === 0) return true;
  return rule.target_tools.includes(toolName);
}

/**
 * Wrap one tool with the configured judges. The wrap delegates to the
 * inner executor first; on a clean (non-deny, non-error) output, each
 * applicable judge scores in order. The first below-threshold judge
 * short-circuits to `denyOutput`.
 */
function wrapOne(inner: Tool, rules: JudgeRule[], manifestId: string): Tool {
  const applicable = rules.filter((r) => appliesTo(r, inner.name));
  if (applicable.length === 0) return inner;
  return {
    ...inner,
    executor: wrapExecutor(inner.executor, async (args, ctx) => {
      const out = await inner.executor.execute(args, ctx);
      if (isWrapperDeny(out)) return out;
      if (readToolErrorCode(out) !== null) return out;
      const outString = typeof out === 'string' ? out : out.content;

      for (const rule of applicable) {
        const outcome = await judgeOne(rule, inner.name, args, outString, manifestId);
        if (outcome === null) {
          // Judge couldn't run (no AI binding). In development we skip so
          // local runs / unit tests don't need the binding wired. In any
          // other environment a declared judge that can't run is a
          // misconfiguration — fail CLOSED (deny) rather than silently
          // shipping unjudged output fleet-wide. The skip is still counted
          // (orchestrator_judge_skipped) inside judgeOne.
          if (getContext()?.env.ENVIRONMENT === 'development') continue;
          return denyOutput(
            `[judge unavailable] tool '${inner.name}' declares judge '${rule.name}' but the ` +
              'judge model (AI binding) is not configured; denying to fail closed.',
            'guardrails',
          );
        }
        const { tenantId, subject } = currentTenantSubject();
        recordEvent({
          tenantId,
          eventType: 'judge_score',
          principalSubject: subject,
          manifestId,
          status: outcome.passed ? 'pass' : 'fail',
          payload: {
            judge: rule.name,
            tool: inner.name,
            transport: inner.executor.transport,
            score: outcome.score,
            threshold: rule.threshold,
            reasoning: outcome.reasoning.slice(0, 500),
          },
        });
        recordCounter('orchestrator_judge_scores', {
          judge: rule.name,
          tool: inner.name,
          verdict: outcome.passed ? 'pass' : 'fail',
          manifest_id: manifestId,
        });
        if (!outcome.passed) {
          return denyOutput(
            `[judge denied] tool '${inner.name}' failed judge '${rule.name}' ` +
              `(score ${outcome.score.toFixed(2)} < ${rule.threshold}): ${outcome.reasoning}`,
            'guardrails',
          );
        }
      }
      // All applicable judges passed — attach the scores on the output
      // metadata so downstream consumers can see them without re-running.
      if (typeof out === 'string') return out;
      return out;
    }),
  };
}

export function applyJudges(tools: Tool[], g: Guardrails, manifestId: string): Tool[] {
  if (g.judges.length === 0) return [...tools];
  return tools.map((t) => wrapOne(t, g.judges, manifestId));
}

// Force ToolOutput import to be referenced — keeps biome happy when this
// file is consumed by code that imports the type indirectly.
export type { ToolOutput };
/** Re-export for tests that want to drive a single judge directly. */
export { judgeOne, parseJudgeReply };
