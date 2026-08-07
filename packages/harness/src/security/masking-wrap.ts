/**
 * `applySecretMasking` — the innermost governance wrapper.
 *
 * Applied before every other stage at build time, which makes it the LAST
 * thing to run on the way in and the FIRST on the way out: it sees a tool's
 * raw output before the injection classifier, the guardrail filter, a judge,
 * or the react loop's audit row. That ordering is the whole point. Every one
 * of those either reads the text into a model or writes it somewhere durable,
 * so a secret still present at that point has already leaked.
 *
 * Unlike the other stages this is not opt-in. There is no manifest where
 * echoing this Worker's own credentials back into a context window is the
 * intended behavior, and requiring a flag would mean the manifests that forgot
 * to set it are exactly the ones that leak.
 */

import type { Env } from '../env';
import { recordCounter } from '../observability/metrics';
import { ToolError } from '../tools/errors';
import { wrapExecutor } from '../tools/executor';
import { isWrapperDeny, type Tool, type ToolOutput } from '../tools/types';
import { secretMaskerFor } from './secret-masking';

/** Re-shape output with masked content, preserving any metadata it carried. */
function reshape(original: ToolOutput, content: string): ToolOutput {
  if (typeof original === 'string') return content;
  return { ...original, content };
}

export function applySecretMasking(tools: Tool[], env: Env, manifestId: string): Tool[] {
  const masker = secretMaskerFor(env);
  // Nothing secret-shaped in this environment — skip the wrap entirely rather
  // than paying a no-op indirection on every tool call.
  if (masker.size === 0) return [...tools];

  return tools.map((inner) => ({
    ...inner,
    executor: wrapExecutor(inner.executor, async (args, ctx) => {
      // A tool returning one of our own credentials is a real finding, not
      // routine — it means an upstream is echoing what we sent it, or a
      // container is printing its environment. Count it so it is visible
      // rather than silently cleaned up forever.
      const countMask = () =>
        recordCounter('orchestrator_secret_masked', {
          tool: inner.name,
          transport: inner.executor.transport,
          manifest_id: manifestId,
        });

      let out: ToolOutput;
      try {
        out = await inner.executor.execute(args, ctx);
      } catch (err) {
        // `throw new ToolError(...)` is the sanctioned hard-error convention,
        // so a thrown message is ordinary tool output — and it goes further
        // than a returned one: the react loop writes it to the `tool_call`
        // audit row, appends it to the session transcript (where it re-enters
        // context on every later turn), and for a `fatal` tool surfaces it
        // DIRECTLY as the user-visible final answer. Masking only the returned
        // value would leave the loudest path unprotected.
        const message = String((err as Error)?.message ?? err);
        const maskedMessage = masker.mask(message);
        if (maskedMessage === message) throw err;
        countMask();
        // Rethrow something `inferErrorCode` still classifies the same way:
        // a ToolError keeps its code, anything else keeps its name.
        if (err instanceof ToolError) throw new ToolError(err.code, maskedMessage);
        const replacement = new Error(maskedMessage);
        if ((err as Error)?.name) replacement.name = (err as Error).name;
        throw replacement;
      }

      // A wrapper deny is harness-authored text and cannot contain a secret
      // this Worker holds.
      if (isWrapperDeny(out)) return out;

      const content = typeof out === 'string' ? out : out.content;
      if (!content) return out;
      const masked = masker.mask(content);
      if (masked === content) return out;

      countMask();
      return reshape(out, masked);
    }),
  }));
}
