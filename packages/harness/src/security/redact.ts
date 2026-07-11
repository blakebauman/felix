/**
 * Best-effort secret redaction for values that get persisted to D1
 * (audit_events.payload_json, approvals.args_json) or written to logs.
 *
 * Heuristic: any value under a key whose name matches one of the
 * `SECRET_KEY_PATTERNS` is replaced with `'[REDACTED]'`. Strings shaped like
 * JWTs / long opaque tokens are also replaced even when the key name is
 * benign (defense-in-depth). Nested objects and arrays are walked up to
 * `MAX_DEPTH` levels.
 *
 * This is intentionally a heuristic — full DLP would require per-tool
 * schema annotations. The goal here is to stop trivially-shaped secrets
 * (Bearer tokens, OpenAI/Anthropic keys, passwords) from landing in
 * tenant-readable audit rows.
 */

const SECRET_KEY_PATTERNS = [
  /token/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /api[_-]?key/i,
  /authorization/i,
  /bearer/i,
  /credential/i,
  /private[_-]?key/i,
];

// Looks like an Anthropic / OpenAI / Stripe / generic-Base64URL token.
const SECRET_VALUE_PATTERNS = [
  /^sk-[A-Za-z0-9_-]{16,}$/, // openai-style
  /^sk-ant-[A-Za-z0-9_-]{16,}$/, // anthropic
  /^pk_(test|live)_[A-Za-z0-9]{16,}$/, // stripe pub
  /^rk_(test|live)_[A-Za-z0-9]{16,}$/, // stripe restricted
  /^Bearer\s+\S+$/i,
  /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
];

const MAX_DEPTH = 6;
export const REDACTED = '[REDACTED]';

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((p) => p.test(key));
}

function isSecretValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length < 16) return false;
  return SECRET_VALUE_PATTERNS.some((p) => p.test(value));
}

export function redactSecrets<T = unknown>(input: T, depth = 0): T {
  if (depth > MAX_DEPTH) return REDACTED as unknown as T;
  if (input == null) return input;
  if (Array.isArray(input)) {
    return input.map((v) => redactSecrets(v, depth + 1)) as unknown as T;
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (isSecretKey(k)) {
        out[k] = REDACTED;
      } else if (isSecretValue(v)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactSecrets(v, depth + 1);
      }
    }
    return out as unknown as T;
  }
  if (isSecretValue(input)) return REDACTED as unknown as T;
  return input;
}
