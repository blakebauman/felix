/**
 * Self-issued JWKS route. Serves the configured `JWKS_PUBLIC` document so the
 * worker can act as its own OIDC-style issuer for token verification.
 */

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('GET /.well-known/jwks.json', () => {
  it('serves the configured JWKS as JSON', async () => {
    const r = await SELF.fetch('https://o.test/.well-known/jwks.json');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const body = (await r.json()) as { keys: Array<{ kid: string }> };
    expect(body.keys[0]?.kid).toBe('test-kid');
  });
});
