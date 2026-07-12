/**
 * Tool error taxonomy.
 *
 * Every tool failure — synchronous (a thrown `Error`) or soft (a returned
 * `toolErrorOutput`) — maps to one of the codes below. The code lands on:
 *
 *   - `audit_events.payload.error_code` (queryable in `/audit/metrics`)
 *   - `orchestrator_tool_calls` Analytics Engine labels
 *   - the `tool_result` content string the model sees (prefixed
 *     `[<source> error/<code>] …`), so the model can branch deterministically
 *
 * Codes intentionally mirror the buckets Cursor describes in "Continually
 * Improving Agent Harness": `invalid_arguments`, `transport_unavailable`,
 * `provider_error`, `timeout`, `user_aborted`, `rate_limited`,
 * `permission_denied`, `internal`. The anomaly detector groups by
 * `(manifest, tool, error_code)` so the code set must stay stable.
 *
 * Two seams:
 *   - `toolErrorOutput(code, content)` — soft error. The executor returns
 *     this so the model sees the message and may recover; the harness
 *     reads `error_code` off the metadata for audit + metrics.
 *   - `throw new ToolError(code, message)` — hard error. The harness
 *     catches it, derives a code via `inferErrorCode`, and records it.
 */

import type { ToolOutput } from './types';

/**
 * Extract the model-facing string content from any `ToolOutput`. Identity
 * for string outputs; reads `.content` for the metadata-bearing object
 * shape that `denyOutput` / `toolErrorOutput` return.
 */
export function toolOutputContent(out: ToolOutput): string {
  return typeof out === 'string' ? out : out.content;
}

/**
 * Module-private brand stamped on soft-error outputs. Like the wrapper-deny
 * marker in `tools/types.ts`, this is a `Symbol` — never exported — NOT a
 * public string key. A tool handler can return an arbitrary
 * `{ content, metadata }` object; a public string flag would let a
 * malicious/buggy tool FORGE a tool-error classification, which
 * `readToolErrorCode` treats as "already an error" — exempting the output
 * from judges (`judge-wrap.ts`) and mislabeling its `tool_call` audit row
 * (`react.ts`). Because the symbol is never exported, only `toolErrorOutput`
 * can stamp it. It survives object spreads (symbol-keyed own props are
 * copied) and is only checked in-memory before serialization, so JSON
 * round-tripping is not a concern.
 */
const TOOL_ERROR_MARKER = Symbol('felix.tool_error');

export type ToolErrorCode =
  | 'invalid_arguments'
  | 'transport_unavailable'
  | 'provider_error'
  | 'timeout'
  | 'user_aborted'
  | 'rate_limited'
  | 'permission_denied'
  | 'internal';

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/**
 * Build a soft-error `ToolOutput`. The `content` string is what the model
 * sees and recovers from; the metadata carries the code so audit /
 * observability code reads it without parsing the string.
 */
export function toolErrorOutput(code: ToolErrorCode, content: string): ToolOutput {
  return { content, metadata: { [TOOL_ERROR_MARKER]: true, error_code: code } };
}

/**
 * Read the error code off a `ToolOutput` returned by an executor. Returns
 * `null` for ok outputs and wrapper-deny outputs (those have their own
 * flag and audit path).
 */
export function readToolErrorCode(output: ToolOutput): ToolErrorCode | null {
  if (typeof output === 'string') return null;
  const md = output.metadata as Record<PropertyKey, unknown> | undefined;
  // Branded check: only outputs stamped by `toolErrorOutput` carry the
  // module-private symbol. A tool returning `{ __felix_tool_error__: true }`
  // (or any plain-object shape) can't forge it.
  if (!md || md[TOOL_ERROR_MARKER] !== true) return null;
  const code = md.error_code;
  return typeof code === 'string' ? (code as ToolErrorCode) : null;
}

/**
 * Best-effort mapping of an arbitrary thrown error to a `ToolErrorCode`.
 * Used by the react/deep loop's catch branch so an exception out of any
 * transport still lands on a stable taxonomy in audit.
 */
export function inferErrorCode(err: unknown): ToolErrorCode {
  if (err instanceof ToolError) return err.code;
  const e = err as { name?: string; code?: string; status?: number; message?: string };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'user_aborted';
  if (typeof e?.code === 'string') {
    if (e.code === 'ETIMEDOUT' || e.code === 'ETIME') return 'timeout';
    if (
      e.code === 'ECONNREFUSED' ||
      e.code === 'ENOTFOUND' ||
      e.code === 'ECONNRESET' ||
      e.code === 'EHOSTUNREACH'
    )
      return 'transport_unavailable';
  }
  if (typeof e?.status === 'number') {
    if (e.status === 429) return 'rate_limited';
    if (e.status === 401 || e.status === 403) return 'permission_denied';
    if (e.status >= 500) return 'provider_error';
    if (e.status >= 400) return 'invalid_arguments';
  }
  return 'internal';
}

/**
 * Map an HTTP response status to the closest `ToolErrorCode`. Used by
 * transport executors that build a soft-error output from an upstream
 * non-2xx response.
 */
export function codeForStatus(status: number): ToolErrorCode {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'permission_denied';
  if (status >= 500) return 'provider_error';
  if (status >= 400) return 'invalid_arguments';
  return 'transport_unavailable';
}
