import { describe, expect, it } from 'vitest';
import { parseVerifiers } from '../../src/auth/jwt';
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
    // valid verifier survives; the bare-scheme entry is dropped
    expect(parseVerifiers(env('access, cognito https://issuer.example/pool'))).toEqual([
      { scheme: 'cognito', issuer: 'https://issuer.example/pool', audience: undefined },
    ]);
  });

  it('skips entries with an unknown scheme', () => {
    expect(parseVerifiers(env('oidc https://issuer.example aud'))).toEqual([]);
    expect(parseVerifiers(env('bogus foo, access felix.cloudflareaccess.com aud'))).toEqual([
      { scheme: 'access', issuer: 'felix.cloudflareaccess.com', audience: 'aud' },
    ]);
  });
});
