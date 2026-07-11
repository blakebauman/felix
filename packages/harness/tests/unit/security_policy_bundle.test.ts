/**
 * Guard for the fail-closed contract on the federated PolicyBundle signature
 * (`policy/bundle.ts:loadFromR2`). This is the control that keeps an unsigned
 * or tampered central bundle from overriding manifest policies fleet-wide, so a
 * regression flipping it to fail-open must be caught here.
 *
 * Pinned:
 *   - non-dev + no pubkey            → refuse install (keep previous bundle)
 *   - pubkey set + bad signature     → refuse install (keep previous bundle)
 *   - dev + no pubkey                → install (warn)
 *   - pubkey set + valid signature   → install
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import {
  getActiveBundle,
  loadFromR2,
  setActiveBundle,
  stableStringify,
} from '../../src/policy/bundle';

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function envWith(bundle: Record<string, unknown>, extra: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'production',
    BUNDLES: {
      get: async () => ({ json: async () => bundle }),
    },
    ...(extra as object),
  } as unknown as Env;
}

const baseBundle = { version: '1', issuer: 'central', policies: [], approvals: [] };

afterEach(() => {
  setActiveBundle(null);
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('PolicyBundle signature fail-closed contract', () => {
  it('refuses to install when no pubkey is configured in a non-dev environment', async () => {
    const previous = { version: 'prev', policies: [], approvals: [] };
    setActiveBundle(previous as never);
    const result = await loadFromR2(envWith({ ...baseBundle, signature: 'whatever' }));
    // Kept the previous bundle rather than installing the new one.
    expect(result).toBe(previous);
    expect(getActiveBundle()).toBe(previous);
  });

  it('refuses to install a bundle whose signature does not verify', async () => {
    const previous = { version: 'prev', policies: [], approvals: [] };
    setActiveBundle(previous as never);
    const { publicKey } = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const pubRaw = new Uint8Array((await crypto.subtle.exportKey('raw', publicKey)) as ArrayBuffer);
    const env = envWith(
      { ...baseBundle, signature: b64(new Uint8Array(64)) }, // bogus signature
      { POLICY_BUNDLE_PUBKEY: b64(pubRaw) },
    );
    const result = await loadFromR2(env);
    expect(result).toBe(previous);
    expect(getActiveBundle()).toBe(previous);
  });

  it('installs an unsigned bundle in development (warns)', async () => {
    const env = envWith({ ...baseBundle, signature: 'unused' }, { ENVIRONMENT: 'development' });
    const result = await loadFromR2(env);
    expect(result?.version).toBe('1');
    expect(getActiveBundle()?.version).toBe('1');
  });

  it('installs a bundle with a valid signature', async () => {
    const { publicKey, privateKey } = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const pubRaw = new Uint8Array((await crypto.subtle.exportKey('raw', publicKey)) as ArrayBuffer);
    const message = new TextEncoder().encode(stableStringify(baseBundle));
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message as BufferSource),
    );
    const env = envWith(
      { ...baseBundle, signature: b64(sig) },
      { POLICY_BUNDLE_PUBKEY: b64(pubRaw) },
    );
    const result = await loadFromR2(env);
    expect(result?.version).toBe('1');
    expect(getActiveBundle()?.version).toBe('1');
  });
});
