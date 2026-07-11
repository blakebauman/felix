import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { verifyJwt } from '../../src/auth/jwt';
import type { Env } from '../../src/env';

// Spy on jose's local-JWKS constructor so we can assert the resolver is built
// once and reused across verifyJwt calls (the per-request re-creation was the
// fetch-amplification bug this guards).
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return { ...actual, createLocalJWKSet: vi.fn(actual.createLocalJWKSet) };
});

const jose = await import('jose');

const ISSUER = 'https://self.felix.test';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const pubJwk = await exportJWK(publicKey);
  pubJwk.kid = 'test-key';
  pubJwk.alg = 'RS256';
  const jwksPublic = JSON.stringify({ keys: [pubJwk] });
  const token = await new SignJWT({ scope: 'chat:invoke', tenant_id: 'acme' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { jwksPublic, token };
}

describe('self-issued JWKS verification + memoization', () => {
  it('verifies a self-issued token and reuses the local JWKS across calls', async () => {
    const { jwksPublic, token } = await setup();
    const env = { ENVIRONMENT: 'production', JWKS_PUBLIC: jwksPublic } as unknown as Env;
    const configs = [{ scheme: 'cognito' as const, issuer: ISSUER }];

    const first = await verifyJwt(env, token, configs);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.principal.tenantId).toBe('acme');
      expect(first.principal.scopes).toContain('chat:invoke');
    }

    const before = (jose.createLocalJWKSet as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    const second = await verifyJwt(env, token, configs);
    expect(second.ok).toBe(true);
    const after = (jose.createLocalJWKSet as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    // The resolver was memoized — no new local JWKS built on the second verify.
    expect(after).toBe(before);
  });
});
