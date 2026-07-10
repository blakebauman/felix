/**
 * Reference-based artifacts — context-engineering primitive.
 *
 * Big tool outputs (sandbox stdout dumps, scraped HTML, large JSON
 * arrays) blow the context window. This module spills oversized
 * results to R2 and returns a stub the model can fetch piecewise via
 * the `fetch_artifact` built-in tool.
 *
 * The flow:
 *
 *   tool_result content > threshold
 *      ↓
 *   spillArtifact(env, tenantId, threadId, toolCallId, content)
 *      → writes the full text to R2 under
 *        `artifacts/{tenant}/{thread}/{tool_call_id}.txt`
 *      → returns a stub: "[artifact:{ref}] <preview>… (N chars total)"
 *
 *   Model wants more → calls fetch_artifact({ ref, start?, length? })
 *      → reads the R2 object, returns the requested byte range
 *
 * The model is taught about the protocol via the auto-injected tool
 * description; no manifest changes beyond enabling
 * `spec.artifacts.enabled: true`.
 *
 * R2 keyspace is tenant + thread scoped so an artifact written under
 * one conversation can't be accessed from another. The
 * `fetch_artifact` tool reads `RequestContext.tenantId` + `threadId`
 * directly — refs from a different scope return a stable
 * `[artifact not found]` string rather than leaking existence.
 */

import { z } from 'zod';
import { getContext } from '../context';
import type { Env } from '../env';
import { recordCounter } from '../observability/metrics';
import { defineTool, type Tool } from './types';

export interface ArtifactsOpts {
  enabled: boolean;
  /** Tool-result content above this character count gets spilled. */
  threshold_chars: number;
  /** First N chars retained inline in the stub the model sees. */
  preview_chars: number;
  /** Default chars returned when `fetch_artifact` omits `length`. */
  default_window_chars: number;
  /** Hard cap on a single `fetch_artifact` window. */
  max_window_chars: number;
}

export const DEFAULT_ARTIFACTS_OPTS: ArtifactsOpts = {
  enabled: false,
  threshold_chars: 8000,
  preview_chars: 200,
  default_window_chars: 4000,
  max_window_chars: 16000,
};

function artifactKey(tenantId: string, threadId: string, toolCallId: string): string {
  // The toolCallId is opaque (`tc1`, `tc_xyz`, …) — encode for safety.
  return `artifacts/${encodeURIComponent(tenantId)}/${encodeURIComponent(
    threadId,
  )}/${encodeURIComponent(toolCallId)}.txt`;
}

/**
 * Write `content` to R2 and return a stub the model sees. Idempotent
 * on `toolCallId` — a retried turn that re-spills the same ref
 * overwrites in place, mirroring how `tool_call_id`-keyed events
 * dedupe in the session log.
 */
export async function spillArtifact(
  env: Env,
  opts: ArtifactsOpts,
  ref: { tenantId: string; threadId: string; toolCallId: string },
  content: string,
): Promise<string> {
  const key = artifactKey(ref.tenantId, ref.threadId, ref.toolCallId);
  try {
    await env.BUNDLES.put(key, content, {
      customMetadata: { tenant_id: ref.tenantId, thread_id: ref.threadId },
    });
  } catch (err) {
    // Spill failure → return the original content unmodified rather
    // than the stub. The model still sees the data and the turn
    // proceeds, but emit a counter so a failing R2 path (which silently
    // defeats the artifact mechanism — oversized results flow inline)
    // is observable instead of buried in a console.warn.
    console.warn('artifact spill failed', (err as Error).message);
    recordCounter('orchestrator_artifact_spill_failed', {
      manifest_id: getContext()?.manifestId ?? '',
    });
    return content;
  }
  const preview = content.slice(0, opts.preview_chars).replace(/\s+/g, ' ').trim();
  return (
    `[artifact:${ref.toolCallId}] ${preview}` +
    `\n[truncated — ${content.length} chars total. ` +
    `Call fetch_artifact({ref: "${ref.toolCallId}", start, length}) to read a window.]`
  );
}

/**
 * Build the auto-injected `fetch_artifact` tool. The handler resolves
 * tenant + thread from the request context, reads the R2 object, and
 * returns the requested byte range (default `default_window_chars`
 * from offset 0).
 */
export function fetchArtifactTool(opts: ArtifactsOpts): Tool {
  return defineTool({
    name: 'fetch_artifact',
    description:
      'Read a window of an oversized tool result previously spilled to R2. ' +
      'Use when a tool returned `[artifact:REF]` and you need to read more ' +
      'than the inline preview. `start` is the byte offset (default 0); ' +
      '`length` is the window size (default ' +
      `${opts.default_window_chars}` +
      ', max ' +
      `${opts.max_window_chars}` +
      ').',
    args: z.object({
      ref: z.string().describe('The artifact ref from the tool-result stub.'),
      start: z.number().int().min(0).optional().describe('Byte offset (default 0).'),
      length: z.number().int().positive().optional().describe('Window size in chars.'),
    }),
    handler: async ({ ref, start, length }) => {
      const ctx = getContext();
      if (!ctx) return '[artifact error] no request context available';
      const tenantId = ctx.auth.principal.tenantId;
      const threadId = ctx.threadId ?? '';
      if (!threadId) {
        return '[artifact error] this request has no threadId — artifacts are thread-scoped';
      }
      const key = artifactKey(tenantId, threadId, ref);
      const obj = await ctx.env.BUNDLES.get(key);
      if (!obj) return '[artifact not found]';
      const content = await obj.text();
      const offset = start ?? 0;
      const window = Math.min(length ?? opts.default_window_chars, opts.max_window_chars);
      const slice = content.slice(offset, offset + window);
      const tail = offset + window < content.length;
      return tail
        ? `${slice}\n[continued — ${content.length - offset - window} chars remaining; ` +
            `next call: fetch_artifact({ref: "${ref}", start: ${offset + window}})]`
        : slice;
    },
  });
}
