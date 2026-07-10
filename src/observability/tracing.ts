/**
 * Lightweight, dependency-free span helpers.
 *
 * Each span captures its start time and any attributes set on it; on
 * `end()` it emits a single structured `console.log` line that Workers
 * Logs surfaces and a downstream collector can re-key into OTLP if
 * needed. When a real OTLP exporter is wired (`@microlabs/otel-cf-workers`
 * or similar), this module is the integration point — every caller
 * already routes through `makeSpan` / `withSpan`.
 *
 * The span itself is a closure over mutable state; we deliberately
 * avoid threading it through `RequestContext` so callers don't have to
 * propagate it. Tool-call spans live for one dispatch and close on the
 * `finally` branch of the wrapper.
 *
 * Emission shape (one line per span):
 *   { span: <name>, duration_ms: <int>, attributes: { … } }
 *
 * `duration_ms` makes histograms trivial; `attributes` keeps the slice
 * dimensions flat so JSON-log indexing in tail / Workers Logs is cheap.
 */

export type SpanAttributeValue = string | number | boolean;

export interface SpanAttributes {
  [key: string]: SpanAttributeValue | undefined;
}

export interface SpanContext {
  end(): void;
  setAttribute(key: string, value: SpanAttributeValue): void;
}

function emit(name: string, startedAt: number, attrs: SpanAttributes): void {
  const sanitized: Record<string, SpanAttributeValue> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) sanitized[k] = v;
  }
  console.log(
    JSON.stringify({ span: name, duration_ms: Date.now() - startedAt, attributes: sanitized }),
  );
}

export function makeSpan(name: string, attributes: SpanAttributes = {}): SpanContext {
  const state = {
    startedAt: Date.now(),
    attrs: { ...attributes } as SpanAttributes,
    ended: false,
  };
  return {
    setAttribute(key, value) {
      state.attrs[key] = value;
    },
    end() {
      if (state.ended) return;
      state.ended = true;
      emit(name, state.startedAt, state.attrs);
    },
  };
}

/**
 * Per-manifest build-time span. Preserved for the one caller in
 * `src/manifests/builder.ts`; behavior matches the legacy stub but the
 * span now carries duration.
 */
export function manifestSpan(name: string, version: string): SpanContext {
  return makeSpan('manifest', { manifest_name: name, manifest_version: version });
}

/**
 * Run `fn` under a freshly-created span. The callback may set
 * additional attributes on the span (e.g. result-dependent values like
 * `status` and `error_code`). Thrown errors annotate the span with
 * `error: true` before re-throwing so the loss is visible in tail.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: SpanContext) => Promise<T>,
  attributes: SpanAttributes = {},
): Promise<T> {
  const span = makeSpan(name, attributes);
  try {
    return await fn(span);
  } catch (err) {
    span.setAttribute('error', true);
    span.setAttribute('error_message', String((err as Error).message ?? err));
    throw err;
  } finally {
    span.end();
  }
}
