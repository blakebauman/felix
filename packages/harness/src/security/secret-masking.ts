/**
 * Masking this Worker's own secrets out of tool output.
 *
 * `scrubSecretSubstrings` catches credentials by SHAPE — `sk-ant-…`, a JWT, a
 * URL with userinfo. That works for secrets it can recognize, and misses every
 * one it can't: an opaque `CONSUMER_SHARED_SECRET`, a base64 `OAUTH_CACHE_KEY`,
 * an `ACP_API_KEY` that looks like any other string. Those are exactly the
 * values this Worker holds.
 *
 * This is the other half: instead of guessing what a secret looks like, take
 * the values we KNOW are secret — from `env` — and remove them from anything a
 * tool hands back. No pattern needed, no false negatives on unusual formats.
 *
 * The leak is real rather than theoretical. The outbound auth broker injects
 * tokens into MCP, A2A, and container requests; a remote that echoes the
 * request back (debug endpoints do this routinely), an error message that
 * quotes the failing header, or a container that prints its environment all
 * put the credential into the model's context window — and, because the react
 * loop persists whatever the executor returned, into the session transcript
 * and every later context render too.
 *
 * Encoded forms matter as much as the raw one. A tool that reflects a URL
 * returns the token percent-encoded; one that dumps a request body returns it
 * base64'd. Masking only the literal string would leave both untouched while
 * looking like it worked.
 */

import type { Env } from '../env';
import { isSecretKey, isSecretValue } from './redact';

/**
 * Shortest value worth masking. Below this the "secret" is almost certainly a
 * flag or a short config token, and masking it would corrupt unrelated output
 * that happens to contain the same few characters.
 */
const MIN_SECRET_CHARS = 8;

/** Env keys that match a secret-ish NAME but hold public or inert values. */
const NOT_ACTUALLY_SECRET = new Set([
  // The PUBLIC half of the federation signing keypair, and the public JWKS —
  // both are meant to be published, and masking them would corrupt legitimate
  // output that quotes them.
  'POLICY_BUNDLE_PUBKEY',
  'JWKS_PUBLIC',
]);

/**
 * Value shapes that are meant to be public despite looking credential-ish.
 *
 * `isSecretValue` is shared with audit redaction, where over-matching is free
 * defense in depth. Here it is not: this masker rewrites LIVE tool output, so
 * masking a Stripe publishable key — which exists to be handed to a browser —
 * would silently replace it with a marker and break the checkout it was
 * fetched for, with no error to trace.
 */
const PUBLIC_VALUE_PATTERNS = [/^pk_(?:test|live)_[A-Za-z0-9]{16,}$/];

export interface SecretMasker {
  /** Replace every known secret (and its encodings) with a labelled marker. */
  mask(text: string): string;
  /** How many distinct secrets this masker knows about. */
  readonly size: number;
}

/** A masker that does nothing, for envs with no secrets configured. */
const NOOP_MASKER: SecretMasker = { mask: (text) => text, size: 0 };

/**
 * Base64 with and without padding, so both renderings match.
 *
 * `unescape` is deprecated but is the standard UTF-8-safe `btoa` idiom and is
 * present in workerd; a secret is realistically ASCII, and the try/catch means
 * an exotic value simply contributes no base64 form rather than throwing.
 */
function base64Of(value: string): string[] {
  try {
    const encoded = btoa(unescape(encodeURIComponent(value)));
    const unpadded = encoded.replace(/=+$/, '');
    return unpadded === encoded ? [encoded] : [encoded, unpadded];
  } catch {
    return [];
  }
}

/**
 * Every rendering of `value` a tool might hand back: the literal string, its
 * percent-encoded form (reflected URLs), and its base64 forms (dumped request
 * bodies, basic-auth headers).
 */
export function encodingsOf(value: string): string[] {
  const forms = new Set<string>([value]);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) forms.add(encoded);
  for (const b64 of base64Of(value)) forms.add(b64);
  return [...forms].filter((f) => f.length >= MIN_SECRET_CHARS);
}

/** Pull the values worth masking out of `env`. */
export function collectSecrets(
  env: Record<string, unknown>,
): Array<{ key: string; value: string }> {
  const secrets: Array<{ key: string; value: string }> = [];
  for (const key of Object.keys(env)) {
    // Read defensively: `env` carries bindings as well as strings, and a
    // property whose accessor throws must not take down audit recording —
    // which is where this runs — just because the masker enumerated it.
    let value: unknown;
    try {
      value = env[key];
    } catch {
      continue;
    }
    if (typeof value !== 'string') continue;
    if (value.length < MIN_SECRET_CHARS) continue;
    if (NOT_ACTUALLY_SECRET.has(key)) continue;
    // Either the name says it is a secret, or the value is shaped like one.
    // Both heuristics already back audit redaction, so a value masked here is
    // one the codebase already treats as sensitive elsewhere.
    if (PUBLIC_VALUE_PATTERNS.some((p) => p.test(value))) continue;
    if (!isSecretKey(key) && !isSecretValue(value)) continue;
    secrets.push({ key, value });
  }
  return secrets;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a masker for `env`. Cached per env object — the secret set can't change
 * within an isolate, and rebuilding it per tool call would scan the whole
 * environment on every dispatch.
 */
const cache = new WeakMap<object, SecretMasker>();

export function secretMaskerFor(env: Env | undefined): SecretMasker {
  if (!env || typeof env !== 'object') return NOOP_MASKER;
  const key = env as unknown as object;
  const existing = cache.get(key);
  if (existing) return existing;

  const secrets = collectSecrets(env as unknown as Record<string, unknown>);
  if (secrets.length === 0) {
    cache.set(key, NOOP_MASKER);
    return NOOP_MASKER;
  }

  // One alternation over every form, so masking is a SINGLE pass regardless of
  // how many secrets the environment holds. Scanning per-secret meant ~27
  // full-length passes over an output that can reach 8 MiB, on every tool call
  // in production — the cost scaled with both secret count and payload size.
  //
  // Longest form first: JS alternation is leftmost-FIRST, not leftmost-longest,
  // so a short encoding listed ahead of a longer one containing it would match
  // first and leave the longer form's tail exposed.
  const labelOf = new Map<string, string>();
  const patterns: string[] = [];
  for (const { key: name, value } of secrets) {
    for (const form of encodingsOf(value)) {
      if (labelOf.has(form)) continue;
      labelOf.set(form, `[redacted:${name}]`);
      patterns.push(form);
    }
  }
  patterns.sort((a, b) => b.length - a.length);
  const combined = new RegExp(patterns.map(escapeForRegex).join('|'), 'g');

  const masker: SecretMasker = {
    size: secrets.length,
    mask(text: string): string {
      if (!text) return text;
      combined.lastIndex = 0;
      return text.replace(combined, (match) => labelOf.get(match) ?? match);
    },
  };
  cache.set(key, masker);
  return masker;
}

/** Convenience for callers that already have the text and the env. */
export function maskSecrets(env: Env | undefined, text: string): string {
  return secretMaskerFor(env).mask(text);
}

/**
 * Deep-mask every string in a value against this Worker's known secrets.
 *
 * `redactSecrets` decides by key name and value shape and so cannot recognize
 * an opaque secret at all; this knows the actual values. Used on audit payloads,
 * where a secret can arrive through a path the tool-output masker never sees —
 * most plausibly a model echoing something back as a tool-call argument, which
 * lands in `tool_call.args` and in an approval row.
 */
export function maskSecretsDeep<T = unknown>(env: Env | undefined, input: T, depth = 0): T {
  const masker = secretMaskerFor(env);
  if (masker.size === 0 || depth > 6) return input;
  if (typeof input === 'string') return masker.mask(input) as unknown as T;
  if (input == null) return input;
  if (Array.isArray(input)) {
    return input.map((v) => maskSecretsDeep(env, v, depth + 1)) as unknown as T;
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = maskSecretsDeep(env, v, depth + 1);
    }
    return out as unknown as T;
  }
  return input;
}
