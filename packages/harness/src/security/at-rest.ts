/**
 * At-rest encryption for sensitive columns (currently
 * `oauth_token_cache.access_token`). AES-256-GCM via WebCrypto, with a
 * fresh 96-bit IV per ciphertext. Storage format is base64 of
 * `iv || ciphertext_with_tag`.
 *
 * The key lives in the Worker secret `OAUTH_CACHE_KEY` (base64 32 bytes).
 * Generate one with:
 *
 *   openssl rand -base64 32 | wrangler secret put OAUTH_CACHE_KEY
 *
 * Rotation: just put a new secret. Existing ciphertexts fail to decrypt
 * and the caller is expected to treat that as a cache miss + refetch.
 *
 * Dev fallback: when the key isn't configured AND `ENVIRONMENT` is
 * `development`, values pass through in plaintext (with a one-shot
 * console warning). Non-dev environments throw on encrypt to fail
 * closed — better than silently storing plaintext under the impression
 * that encryption is on.
 */

import type { Env } from '../env';

const IV_LEN = 12; // 96-bit IV is the AES-GCM standard
const KEY_LEN_BYTES = 32; // AES-256
const TAG_LEN_BYTES = 16; // AES-GCM authentication tag

let warnedDevPlaintext = false;

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function importAesKey(rawB64: string): Promise<CryptoKey> {
  const raw = b64decode(rawB64);
  if (raw.length !== KEY_LEN_BYTES) {
    throw new Error(`OAUTH_CACHE_KEY must decode to ${KEY_LEN_BYTES} bytes (got ${raw.length})`);
  }
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function devFallbackOrThrow(env: Env, op: 'encrypt' | 'decrypt'): boolean {
  if (env.ENVIRONMENT === 'development') {
    if (!warnedDevPlaintext) {
      warnedDevPlaintext = true;
      console.warn(
        `at_rest.${op}: OAUTH_CACHE_KEY not set; storing token cache values in plaintext (dev only)`,
      );
    }
    return true;
  }
  throw new Error(`OAUTH_CACHE_KEY required for at-rest ${op} in ${env.ENVIRONMENT}`);
}

export async function encryptAtRest(env: Env, plaintext: string): Promise<string> {
  const keyB64 = env.OAUTH_CACHE_KEY;
  if (!keyB64) {
    devFallbackOrThrow(env, 'encrypt');
    return plaintext;
  }
  const key = await importAesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ptBytes = new TextEncoder().encode(plaintext);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, ptBytes as BufferSource),
  );
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv, 0);
  blob.set(ct, iv.length);
  return b64encode(blob);
}

/**
 * Returns null when the stored blob can't be decrypted (wrong/rotated
 * key, tampered ciphertext, or — in dev — legacy plaintext that doesn't
 * even base64-decode to a sensible length). Callers should treat that as
 * a cache miss.
 */
export async function decryptAtRest(env: Env, blob: string): Promise<string | null> {
  const keyB64 = env.OAUTH_CACHE_KEY;
  if (!keyB64) {
    devFallbackOrThrow(env, 'decrypt');
    return blob;
  }
  try {
    const key = await importAesKey(keyB64);
    const bytes = b64decode(blob);
    if (bytes.length < IV_LEN + TAG_LEN_BYTES) return null;
    const iv = bytes.slice(0, IV_LEN);
    const ct = bytes.slice(IV_LEN);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ct as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
