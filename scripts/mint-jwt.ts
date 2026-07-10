/**
 * Self-issued JWT minter for testing scoped writes against a deployment whose
 * `JWT_VERIFIERS` trusts this worker's own `/.well-known/jwks.json`.
 *
 * On first run it generates an RS256 keypair and saves the private half to
 * `.secrets/jwt-signing-key.json` (gitignored). It prints, as JSON:
 *   - `jwks`  : the public JWKS to serve (set as the `JWKS_PUBLIC` secret)
 *   - `token` : a signed JWT with the requested issuer / subject / tenant / scopes
 *
 * Usage:
 *   pnpm tsx scripts/mint-jwt.ts \
 *     --iss https://staging-make.felix.run \
 *     --sub smoke@felix.run --tenant default \
 *     --scope "brands:write b2b:write entities:write manifests:write"
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from 'jose';

const KEY_FILE = '.secrets/jwt-signing-key.json';
const KID = 'orderloop-self-issued-1';
const ALG = 'RS256';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

interface KeyMaterial {
  privateJwk: JWK;
  publicJwk: JWK;
}

async function loadOrCreateKey(): Promise<KeyMaterial> {
  try {
    return JSON.parse(readFileSync(KEY_FILE, 'utf8')) as KeyMaterial;
  } catch {
    const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
    const privateJwk = { ...(await exportJWK(privateKey)), kid: KID, alg: ALG, use: 'sig' };
    const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: ALG, use: 'sig' };
    mkdirSync('.secrets', { recursive: true });
    writeFileSync(KEY_FILE, JSON.stringify({ privateJwk, publicJwk }, null, 2));
    return { privateJwk, publicJwk };
  }
}

async function main() {
  const iss = arg('iss', 'https://staging-make.felix.run');
  const sub = arg('sub', 'smoke@felix.run');
  const tenant = arg('tenant', 'default');
  const scope = arg('scope', 'brands:write b2b:write entities:write manifests:write');
  const aud = arg('aud');
  const ttl = Number.parseInt(arg('ttl', '3600'), 10);

  const { privateJwk, publicJwk } = await loadOrCreateKey();
  const signingKey = await importJWK(privateJwk, ALG);

  const builder = new SignJWT({ scope, 'custom:tenant_id': tenant })
    .setProtectedHeader({ alg: ALG, kid: KID })
    .setIssuedAt()
    .setIssuer(iss)
    .setSubject(sub)
    .setExpirationTime(`${ttl}s`);
  if (aud) builder.setAudience(aud);
  const token = await builder.sign(signingKey);

  process.stdout.write(`${JSON.stringify({ jwks: { keys: [publicJwk] }, token })}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
