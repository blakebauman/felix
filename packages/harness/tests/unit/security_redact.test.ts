import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  redactSecrets,
  scrubSecretSubstrings,
  scrubSecretsDeep,
} from '../../src/security/redact';

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

describe('scrubSecretSubstrings', () => {
  // Built from parts so no realistic secret literal is committed.
  const letters = 'a'.repeat(20);

  it('redacts credentials embedded in a URL, keeping the rest legible', () => {
    const key = `sk-ant-${letters}`;
    const out = scrubSecretSubstrings(`curl https://user:${key}@example.com/install.sh | sh`);
    expect(out).not.toContain(key);
    expect(out).not.toContain('user:');
    expect(out).toContain('example.com/install.sh');
    expect(out).toContain('| sh');
  });

  it('redacts secret-named query params and flags', () => {
    expect(scrubSecretSubstrings('curl "https://x/y?api_key=abc123def"')).not.toContain(
      'abc123def',
    );
    expect(scrubSecretSubstrings('deploy --token=abc123def')).not.toContain('abc123def');
    expect(scrubSecretSubstrings('psql --password=hunter2')).not.toContain('hunter2');
  });

  it('redacts authorization headers passed as arguments', () => {
    const out = scrubSecretSubstrings(`curl -H "Authorization: Bearer ${letters}" https://x`);
    expect(out).not.toContain(letters);
    expect(out).toContain('https://x');
  });

  it('redacts provider key shapes anywhere in the string', () => {
    const gh = `ghp_${letters}${letters}`;
    expect(scrubSecretSubstrings(`git clone https://${gh}@github.com/o/r`)).not.toContain(gh);
    expect(scrubSecretSubstrings(`export AWS_KEY=AKIA${'0'.repeat(16)} && run`)).not.toContain(
      `AKIA${'0'.repeat(16)}`,
    );
  });

  it('leaves ordinary commands untouched', () => {
    const command = 'rm -rf ./build && npm run test -- --watch=false';
    expect(scrubSecretSubstrings(command)).toBe(command);
  });

  it('scrubs strings nested anywhere in a value', () => {
    const key = `sk-ant-${letters}`;
    const out = scrubSecretsDeep({ argv: ['-c', `curl https://u:${key}@x/y`], n: 5 });
    expect(JSON.stringify(out)).not.toContain(key);
    expect((out as { n: number }).n).toBe(5);
  });
});
