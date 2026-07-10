import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { decryptAtRest, encryptAtRest } from '../../src/security/at-rest';

function genKeyB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function fakeEnv(extra: Partial<Env> = {}): Env {
  return { ENVIRONMENT: 'production', ...(extra as object) } as Env;
}

describe('at-rest encryption', () => {
  it('round-trips a value with a valid key', async () => {
    const env = fakeEnv({ OAUTH_CACHE_KEY: genKeyB64() });
    const cipher = await encryptAtRest(env, 'sk-ant-abc123');
    expect(cipher).not.toBe('sk-ant-abc123');
    const plain = await decryptAtRest(env, cipher);
    expect(plain).toBe('sk-ant-abc123');
  });

  it('produces different ciphertexts for the same plaintext (fresh IV)', async () => {
    const env = fakeEnv({ OAUTH_CACHE_KEY: genKeyB64() });
    const a = await encryptAtRest(env, 'same-input');
    const b = await encryptAtRest(env, 'same-input');
    expect(a).not.toBe(b);
  });

  it('returns null when decrypted under the wrong key (rotation = cache miss)', async () => {
    const env1 = fakeEnv({ OAUTH_CACHE_KEY: genKeyB64() });
    const cipher = await encryptAtRest(env1, 'secret');

    const env2 = fakeEnv({ OAUTH_CACHE_KEY: genKeyB64() });
    const plain = await decryptAtRest(env2, cipher);
    expect(plain).toBeNull();
  });

  it('returns null on a tampered ciphertext', async () => {
    const env = fakeEnv({ OAUTH_CACHE_KEY: genKeyB64() });
    const cipher = await encryptAtRest(env, 'secret');
    // Flip the last byte before base64 to invalidate the GCM auth tag.
    const tampered = `${cipher.slice(0, -2)}AA`;
    const plain = await decryptAtRest(env, tampered);
    expect(plain).toBeNull();
  });

  it('returns null on legacy plaintext when a key is configured', async () => {
    const env = fakeEnv({ OAUTH_CACHE_KEY: genKeyB64() });
    // A token from before this hardening landed — plaintext, not base64
    // of a (iv+ct+tag). Should be treated as a cache miss so the caller
    // re-fetches under the new format.
    const plain = await decryptAtRest(env, 'ya29.legacy-plaintext-token');
    expect(plain).toBeNull();
  });

  it('falls back to plaintext in development when no key is set', async () => {
    const env = fakeEnv({ ENVIRONMENT: 'development' });
    const cipher = await encryptAtRest(env, 'devtoken');
    expect(cipher).toBe('devtoken');
    expect(await decryptAtRest(env, 'devtoken')).toBe('devtoken');
  });

  it('throws on encrypt in production when key is missing', async () => {
    const env = fakeEnv();
    await expect(encryptAtRest(env, 'oops')).rejects.toThrow(/OAUTH_CACHE_KEY required/);
  });

  it('throws on decrypt in production when key is missing', async () => {
    const env = fakeEnv();
    await expect(decryptAtRest(env, 'anything')).rejects.toThrow(/OAUTH_CACHE_KEY required/);
  });

  it('rejects a short key', async () => {
    const shortKey = btoa('not-32-bytes');
    const env = fakeEnv({ OAUTH_CACHE_KEY: shortKey });
    await expect(encryptAtRest(env, 'x')).rejects.toThrow(/32 bytes/);
  });
});
