import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { parseVerifiers, verifyJwt } from '../../src/auth/jwt';
import type { Env } from '../../src/env';

function env(jwtVerifiers: string): Env {
  return { JWT_VERIFIERS: jwtVerifiers } as Env;
}

describe('parseVerifiers', () => {
  it('returns no verifiers for an empty / whitespace-only value', () => {
    expect(parseVerifiers(env(''))).toEqual([]);
    expect(parseVerifiers(env('   '))).toEqual([]);
    expect(parseVerifiers({} as Env)).toEqual([]);
  });

  it('parses a single access verifier with audience', () => {
    expect(parseVerifiers(env('access felix.cloudflareaccess.com my-app-aud'))).toEqual([
      { scheme: 'access', issuer: 'felix.cloudflareaccess.com', audience: 'my-app-aud' },
    ]);
  });

  it('parses a cognito verifier whose issuer URL contains colons', () => {
    expect(
      parseVerifiers(
        env('cognito https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Ab12 client-id'),
      ),
    ).toEqual([
      {
        scheme: 'cognito',
        issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Ab12',
        audience: 'client-id',
      },
    ]);
  });

  it('treats audience as optional', () => {
    expect(parseVerifiers(env('access felix.cloudflareaccess.com'))).toEqual([
      { scheme: 'access', issuer: 'felix.cloudflareaccess.com', audience: undefined },
    ]);
  });

  it('parses multiple comma-separated verifiers in order', () => {
    expect(
      parseVerifiers(
        env('access acme.cloudflareaccess.com aud1, cognito https://issuer.example/pool client2'),
      ),
    ).toEqual([
      { scheme: 'access', issuer: 'acme.cloudflareaccess.com', audience: 'aud1' },
      { scheme: 'cognito', issuer: 'https://issuer.example/pool', audience: 'client2' },
    ]);
  });

  it('tolerates extra surrounding whitespace and irregular spacing', () => {
    expect(parseVerifiers(env('  access   felix.cloudflareaccess.com   my-aud  '))).toEqual([
      { scheme: 'access', issuer: 'felix.cloudflareaccess.com', audience: 'my-aud' },
    ]);
  });

  it('skips entries missing an issuer', () => {
    expect(parseVerifiers(env('access'))).toEqual([]);
    // valid verifier survives; the bare-scheme entry is dropped (the cognito
    // entry carries an audience so the non-dev audience rule doesn't drop it).
    expect(parseVerifiers(env('access, cognito https://issuer.example/pool aud'))).toEqual([
      { scheme: 'cognito', issuer: 'https://issuer.example/pool', audience: 'aud' },
    ]);
  });

  it('skips entries with an unknown scheme', () => {
    expect(parseVerifiers(env('oidc https://issuer.example aud'))).toEqual([]);
    expect(parseVerifiers(env('bogus foo, access felix.cloudflareaccess.com aud'))).toEqual([
      { scheme: 'access', issuer: 'felix.cloudflareaccess.com', audience: 'aud' },
    ]);
  });

  it('rejects a non-HTTPS cognito issuer outside development (cleartext JWKS)', () => {
    // An http:// issuer would fetch the JWKS (and establish trust) over
    // cleartext. Fail closed by dropping the verifier in non-dev.
    expect(parseVerifiers(env('cognito http://issuer.example/pool aud'))).toEqual([]);
    // https survives.
    expect(parseVerifiers(env('cognito https://issuer.example/pool aud'))).toEqual([
      { scheme: 'cognito', issuer: 'https://issuer.example/pool', audience: 'aud' },
    ]);
  });

  it('allows a non-HTTPS cognito issuer in development for local testing', () => {
    const devEnv = {
      JWT_VERIFIERS: 'cognito http://localhost:8080/pool',
      ENVIRONMENT: 'development',
    } as Env;
    expect(parseVerifiers(devEnv)).toEqual([
      { scheme: 'cognito', issuer: 'http://localhost:8080/pool', audience: undefined },
    ]);
  });

  it('requires an audience for cognito verifiers outside development', () => {
    // Without an audience, any validly-signed token from the issuer would be
    // accepted regardless of `aud` (cross-app replay) — fail closed by skipping.
    expect(parseVerifiers(env('cognito https://issuer.example/pool'))).toEqual([]);
    // With an audience it survives.
    expect(parseVerifiers(env('cognito https://issuer.example/pool client-id'))).toEqual([
      { scheme: 'cognito', issuer: 'https://issuer.example/pool', audience: 'client-id' },
    ]);
  });

  it('allows an audience-less cognito verifier in development', () => {
    const devEnv = {
      JWT_VERIFIERS: 'cognito https://issuer.example/pool',
      ENVIRONMENT: 'development',
    } as Env;
    expect(parseVerifiers(devEnv)).toEqual([
      { scheme: 'cognito', issuer: 'https://issuer.example/pool', audience: undefined },
    ]);
  });

  it('exempts self-issuing deployments (JWKS_PUBLIC) from the cognito audience rule', () => {
    const selfEnv = {
      JWT_VERIFIERS: 'cognito https://self.example/pool',
      JWKS_PUBLIC: '{"keys":[]}',
    } as Env;
    expect(parseVerifiers(selfEnv)).toEqual([
      { scheme: 'cognito', issuer: 'https://self.example/pool', audience: undefined },
    ]);
  });

  it('keeps audience optional for access-scheme verifiers outside development', () => {
    expect(parseVerifiers(env('access felix.cloudflareaccess.com'))).toEqual([
      { scheme: 'access', issuer: 'felix.cloudflareaccess.com', audience: undefined },
    ]);
  });

  it('parses a fixed tenant binding without disturbing the audience', () => {
    expect(
      parseVerifiers(env('cognito https://issuer.example/pool client-id tenant=acme')),
    ).toEqual([
      {
        scheme: 'cognito',
        issuer: 'https://issuer.example/pool',
        audience: 'client-id',
        tenant: { mode: 'fixed', tenantId: 'acme' },
      },
    ]);
  });

  it('accepts the tenant binding before the audience (order-independent)', () => {
    expect(
      parseVerifiers(env('cognito https://issuer.example/pool tenant=acme client-id')),
    ).toEqual([
      {
        scheme: 'cognito',
        issuer: 'https://issuer.example/pool',
        audience: 'client-id',
        tenant: { mode: 'fixed', tenantId: 'acme' },
      },
    ]);
  });

  it('parses the claim and issuer tenant directives', () => {
    expect(parseVerifiers(env('access felix.cloudflareaccess.com aud tenant=claim'))).toEqual([
      {
        scheme: 'access',
        issuer: 'felix.cloudflareaccess.com',
        audience: 'aud',
        tenant: { mode: 'claim' },
      },
    ]);
    expect(parseVerifiers(env('access felix.cloudflareaccess.com aud tenant=issuer'))).toEqual([
      {
        scheme: 'access',
        issuer: 'felix.cloudflareaccess.com',
        audience: 'aud',
        tenant: { mode: 'issuer' },
      },
    ]);
  });

  it('omits the tenant field for legacy entries with no directive (backward compat)', () => {
    const [cfg] = parseVerifiers(env('access felix.cloudflareaccess.com aud'));
    expect(cfg).not.toHaveProperty('tenant');
  });
});

describe('verifyJwt tenant binding', () => {
  async function signedToken(claims: Record<string, unknown>) {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const pub = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuedAt()
      .setIssuer('https://issuer.example/pool')
      .setSubject('user-1')
      .setExpirationTime('1h')
      .sign(privateKey);
    // JWKS_PUBLIC makes verifyJwt resolve the cognito JWKS locally (no fetch).
    return { token, jwks: JSON.stringify({ keys: [pub] }) };
  }

  it('pins the tenant to a fixed binding, ignoring a mutable claim', async () => {
    const { token, jwks } = await signedToken({ 'custom:tenant_id': 'attacker' });
    const res = await verifyJwt({ JWKS_PUBLIC: jwks } as Env, token, [
      {
        scheme: 'cognito',
        issuer: 'https://issuer.example/pool',
        tenant: { mode: 'fixed', tenantId: 'acme' },
      },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.principal.tenantId).toBe('acme');
  });

  it('trusts the tenant claim under the default (claim) binding', async () => {
    const { token, jwks } = await signedToken({ 'custom:tenant_id': 'tenant-from-claim' });
    const res = await verifyJwt({ JWKS_PUBLIC: jwks } as Env, token, [
      { scheme: 'cognito', issuer: 'https://issuer.example/pool' },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.principal.tenantId).toBe('tenant-from-claim');
  });

  it('derives the tenant from the issuer host under the issuer binding', async () => {
    const { token, jwks } = await signedToken({ 'custom:tenant_id': 'attacker' });
    const res = await verifyJwt({ JWKS_PUBLIC: jwks } as Env, token, [
      {
        scheme: 'cognito',
        issuer: 'https://issuer.example/pool',
        tenant: { mode: 'issuer' },
      },
    ]);
    expect(res.ok).toBe(true);
    // first label of `issuer.example` → `issuer`, claim ignored.
    if (res.ok) expect(res.principal.tenantId).toBe('issuer');
  });
});
