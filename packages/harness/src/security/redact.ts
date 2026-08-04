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
  /^sk_(test|live)_[A-Za-z0-9]{16,}$/, // stripe secret
  /^Bearer\s+\S+$/i,
  /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^ASIA[0-9A-Z]{16}$/, // AWS temporary access key id
  /^AIza[0-9A-Za-z_-]{35}$/, // Google API key
  /^gh[posru]_[A-Za-z0-9]{20,}$/, // GitHub PAT / OAuth / server / user / refresh
  /^github_pat_[A-Za-z0-9_]{20,}$/, // GitHub fine-grained PAT
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/, // Slack token
  /^glpat-[A-Za-z0-9_-]{20,}$/, // GitLab PAT
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

/**
 * Secret patterns that appear as a SUBSTRING of a larger string.
 *
 * `redactSecrets` only recognizes a secret that is the entire value, which is
 * the right shape for a tool argument like `{ api_key: 'sk-…' }`. It is the
 * wrong shape for a command line: `curl https://u:sk-ant-…@host/x | sh` carries
 * the credential inside an otherwise-benign string, so a whole-value match
 * never fires and the secret lands verbatim in audit or an approval row.
 */
const SECRET_SUBSTRING_PATTERNS: Array<[RegExp, string]> = [
  // URL userinfo — `scheme://user:password@host` (also covers a bare token as user).
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, `$1${REDACTED}@`],
  // `key=value` query params / flags whose NAME implies a secret.
  [
    /\b(token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|password|passwd|pwd|auth)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi,
    `$1=${REDACTED}`,
  ],
  // Authorization headers passed as CLI arguments. The value runs to the end of
  // the quoted argument, not to the first space — matching a single `\S+` would
  // consume only the `Bearer` scheme and leave the token in place.
  [/\b(authorization|proxy-authorization)\s*:\s*[^"'\n]+/gi, `$1: ${REDACTED}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  // Provider-issued keys, recognized anywhere in the string.
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b[sprk]k_(?:test|live)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bgh[posru]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
];

/**
 * Redact secret-shaped SUBSTRINGS from free text (a command line, a matched
 * rule fragment) before it is persisted or shown to an operator.
 *
 * Best-effort by construction, like `redactSecrets`: it removes the shapes that
 * are recognizable, and cannot know that an arbitrary opaque argument is a
 * credential. Use it wherever a string that may embed a secret has to stay
 * human-readable — full redaction would defeat the purpose of showing an
 * operator the command they are approving.
 */
export function scrubSecretSubstrings(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_SUBSTRING_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Deep-map `scrubSecretSubstrings` over every string in a value. */
export function scrubSecretsDeep<T = unknown>(input: T, depth = 0): T {
  if (depth > MAX_DEPTH) return input;
  if (typeof input === 'string') return scrubSecretSubstrings(input) as unknown as T;
  if (input == null) return input;
  if (Array.isArray(input)) return input.map((v) => scrubSecretsDeep(v, depth + 1)) as unknown as T;
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = scrubSecretsDeep(v, depth + 1);
    }
    return out as unknown as T;
  }
  return input;
}
