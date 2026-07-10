import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import {
  assertSafeOutboundUrl,
  assertSafeOutboundUrlForEnv,
  isOutboundHostAllowed,
} from '../../src/security/ssrf';

function fakeEnv(extra: Partial<Env> = {}): Env {
  return { ENVIRONMENT: 'production', ...(extra as object) } as Env;
}

describe('ssrf guard', () => {
  it('accepts a plain https URL', () => {
    expect(() => assertSafeOutboundUrl('https://api.example.com/foo')).not.toThrow();
  });

  it('rejects http: by default', () => {
    expect(() => assertSafeOutboundUrl('http://api.example.com/foo')).toThrow();
  });

  it('rejects loopback hostnames', () => {
    expect(() => assertSafeOutboundUrl('https://127.0.0.1/')).toThrow();
    expect(() => assertSafeOutboundUrl('https://localhost/')).toThrow();
    expect(() => assertSafeOutboundUrl('https://[::1]/')).toThrow();
  });

  it('rejects RFC1918 IPs', () => {
    expect(() => assertSafeOutboundUrl('https://10.0.0.5/')).toThrow();
    expect(() => assertSafeOutboundUrl('https://172.16.5.1/')).toThrow();
    expect(() => assertSafeOutboundUrl('https://192.168.1.1/')).toThrow();
  });

  it('rejects link-local (IMDS)', () => {
    expect(() => assertSafeOutboundUrl('https://169.254.169.254/latest')).toThrow();
  });

  it('rejects unique-local IPv6', () => {
    expect(() => assertSafeOutboundUrl('https://[fc00::1]/')).toThrow();
    expect(() => assertSafeOutboundUrl('https://[fe80::1]/')).toThrow();
  });

  it('rejects cluster-local hostnames', () => {
    expect(() => assertSafeOutboundUrl('https://api.cluster.local/')).toThrow();
    expect(() => assertSafeOutboundUrl('https://svc.internal/')).toThrow();
  });

  it('rejects alternate IPv4 encodings of loopback/IMDS', () => {
    // decimal, hex, octal, and short-form all canonicalize to a blocked range.
    expect(() => assertSafeOutboundUrl('https://2130706433/')).toThrow(); // 127.0.0.1
    expect(() => assertSafeOutboundUrl('https://0x7f000001/')).toThrow(); // 127.0.0.1
    expect(() => assertSafeOutboundUrl('https://0x7f.0.0.1/')).toThrow();
    expect(() => assertSafeOutboundUrl('https://0177.0.0.1/')).toThrow(); // octal 127
    expect(() => assertSafeOutboundUrl('https://127.1/')).toThrow(); // short-form
    expect(() => assertSafeOutboundUrl('https://2852039166/')).toThrow(); // 169.254.169.254
  });

  it('rejects 0.0.0.0 and the IPv6 unspecified address', () => {
    expect(() => assertSafeOutboundUrl('https://0.0.0.0/')).toThrow();
    expect(() => assertSafeOutboundUrl('https://[::]/')).toThrow();
  });

  it('rejects IPv4-mapped IPv6 pointing at a private/IMDS address', () => {
    expect(() => assertSafeOutboundUrl('https://[::ffff:169.254.169.254]/')).toThrow();
    expect(() => assertSafeOutboundUrl('https://[::ffff:7f00:1]/')).toThrow(); // 127.0.0.1
    expect(() => assertSafeOutboundUrl('https://[::ffff:10.0.0.1]/')).toThrow();
  });

  it('still allows genuine public addresses', () => {
    expect(() => assertSafeOutboundUrl('https://8.8.8.8/')).not.toThrow();
    expect(() => assertSafeOutboundUrl('https://api.example.com/')).not.toThrow();
    expect(() => assertSafeOutboundUrl('https://[2606:4700:4700::1111]/')).not.toThrow();
  });

  it('allow-list overrides private-host check', () => {
    const env = fakeEnv({ SSRF_ALLOW_HOSTS: 'inner.internal' });
    expect(() => assertSafeOutboundUrlForEnv('https://inner.internal/', env)).not.toThrow();
  });

  it('allow-list does NOT waive the https requirement', () => {
    const env = fakeEnv({ SSRF_ALLOW_HOSTS: 'inner.internal' });
    expect(() => assertSafeOutboundUrlForEnv('http://inner.internal/', env)).toThrow();
  });

  it('allows http://localhost in development', () => {
    const env = fakeEnv({ ENVIRONMENT: 'development' });
    expect(() => assertSafeOutboundUrlForEnv('http://localhost:8787/', env)).not.toThrow();
  });

  it('isOutboundHostAllowed is a quiet predicate', () => {
    expect(isOutboundHostAllowed('https://api.example.com', fakeEnv())).toBe(true);
    expect(isOutboundHostAllowed('http://127.0.0.1', fakeEnv())).toBe(false);
  });
});
