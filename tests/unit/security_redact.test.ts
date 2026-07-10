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
});
