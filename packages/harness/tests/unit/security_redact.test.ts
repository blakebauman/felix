import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from '../../src/security/redact';

describe('redactSecrets', () => {
  it('masks values under secret-named keys', () => {
    const input = { password: 'hunter2', api_key: 'pk_live_xxx', token: 'abc' };
    const out = redactSecrets(input);
    expect(out).toEqual({ password: REDACTED, api_key: REDACTED, token: REDACTED });
  });

  it('masks JWT-shaped values regardless of key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactSecrets({ harmless: jwt });
    expect(out).toEqual({ harmless: REDACTED });
  });

  it('walks nested structures', () => {
    const input = { outer: { inner: { secret: 'shhh', ok: 1 } } };
    const out = redactSecrets(input) as { outer: { inner: Record<string, unknown> } };
    expect(out.outer.inner.secret).toBe(REDACTED);
    expect(out.outer.inner.ok).toBe(1);
  });

  it('passes plain values through', () => {
    expect(redactSecrets('plain string')).toBe('plain string');
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
  });

  it('masks Bearer-shaped strings', () => {
    const out = redactSecrets({ description: 'Bearer abcdefghijklmnop' });
    expect(out).toEqual({ description: REDACTED });
  });

  it('masks common cloud/SaaS token shapes under benign keys', () => {
    // These land under innocuous key names, so only the value-shape patterns
    // catch them. Built from parts so no realistic secret literal is committed
    // (avoids tripping upstream secret scanners on obviously-fake test data).
    const digits = '0'.repeat(12);
    const letters = 'a'.repeat(20);
    const out = redactSecrets({
      a: `AKIA${'0'.repeat(16)}`, // AWS access key id
      b: `AIza${'B'.repeat(35)}`, // Google API key (AIza + 35 chars)
      c: `ghp_${letters}${letters}`, // GitHub PAT (gh?_ + long tail)
      d: `xoxb-${digits}-${letters}`, // Slack token
      e: `sk_live_${letters}`, // Stripe secret
    });
    expect(out).toEqual({ a: REDACTED, b: REDACTED, c: REDACTED, d: REDACTED, e: REDACTED });
  });
});
