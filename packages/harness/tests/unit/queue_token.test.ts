/**
 * Per-dispatch capability tokens for the queue write-back channel.
 *
 * The point of the token is that holding one is not the same as being
 * authorized: it names one tenant, one thread, one tool call, and an expiry,
 * and every one of those has to match the request it is presented with. So
 * most of what is asserted here is refusal — a valid signature over the wrong
 * claims, a token that is merely well-formed, one that has aged out.
 */

import { describe, expect, it } from 'vitest';
import {
  authorizeQueueWriteBack,
  DEFAULT_TOKEN_TTL_MS,
  MAX_TOKEN_TTL_MS,
  mintQueueToken,
  verifyQueueToken,
} from '../../src/security/queue-token';

const SECRET = 'a-fleet-signing-secret-value-0123456789';
const CLAIMS = { t: 'acme', th: 'acme:thread-1', c: 'call_1' };
const NOW = 1_800_000_000_000;

describe('mint + verify', () => {
  it('round-trips the claims it was given', async () => {
    const token = await mintQueueToken(SECRET, CLAIMS, DEFAULT_TOKEN_TTL_MS, NOW);
    const result = await verifyQueueToken(SECRET, token, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims).toMatchObject(CLAIMS);
    expect(result.claims.e).toBe(NOW + DEFAULT_TOKEN_TTL_MS);
  });

  it('caps an over-long requested lifetime', async () => {
    // A capability that effectively never expires is a shared secret again.
    const token = await mintQueueToken(SECRET, CLAIMS, MAX_TOKEN_TTL_MS * 10, NOW);
    const result = await verifyQueueToken(SECRET, token, NOW);
    if (!result.ok) throw new Error('expected a valid token');
    expect(result.claims.e).toBe(NOW + MAX_TOKEN_TTL_MS);
  });

  it('falls back to the default for a non-positive lifetime', async () => {
    const token = await mintQueueToken(SECRET, CLAIMS, 0, NOW);
    const result = await verifyQueueToken(SECRET, token, NOW);
    if (!result.ok) throw new Error('expected a valid token');
    expect(result.claims.e).toBe(NOW + DEFAULT_TOKEN_TTL_MS);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await mintQueueToken('some-other-secret-entirely-9876', CLAIMS, undefined, NOW);
    expect(await verifyQueueToken(SECRET, token, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a tampered payload', async () => {
    // Re-encoding the claims without re-signing is the obvious forgery.
    const token = await mintQueueToken(SECRET, CLAIMS, undefined, NOW);
    const signature = token.slice(token.indexOf('.') + 1);
    const forgedPayload = btoa(
      JSON.stringify({ ...CLAIMS, t: 'victim', e: NOW + 1_000_000 }),
    ).replace(/=+$/, '');
    const result = await verifyQueueToken(SECRET, `${forgedPayload}.${signature}`, NOW);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an expired token', async () => {
    const token = await mintQueueToken(SECRET, CLAIMS, 60_000, NOW);
    expect(await verifyQueueToken(SECRET, token, NOW + 60_001)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it.each([
    ['empty', ''],
    ['no separator', 'abcdef'],
    ['payload only', 'abcdef.'],
    ['signature only', '.abcdef'],
    ['garbage', '!!!.???'],
  ])('rejects a %s token', async (_label, token) => {
    const result = await verifyQueueToken(SECRET, token, NOW);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-finite expiry rather than treating it as never-expiring', async () => {
    // `NaN <= now` is false, so a NaN expiry would read as a token that never
    // ages out — the shape check is what closes that.
    // `now` of NaN yields a NaN expiry through mint's own arithmetic.
    const bad = await mintQueueToken(SECRET, CLAIMS, undefined, Number.NaN);
    expect(await verifyQueueToken(SECRET, bad, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a payload whose claims are the wrong shape', async () => {
    // Reached by minting over claims that are missing fields: the signature is
    // genuine, so this exercises the shape check rather than the HMAC — the
    // comparison downstream must never run against undefined fields.
    const token = await mintQueueToken(
      SECRET,
      { hello: 'world' } as unknown as typeof CLAIMS,
      undefined,
      NOW,
    );
    expect(await verifyQueueToken(SECRET, token, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('authorizeQueueWriteBack', () => {
  const request = { tenantId: 'acme', threadId: 'acme:thread-1', toolCallId: 'call_1' };

  it('authorizes exactly the dispatch it was minted for', async () => {
    const token = await mintQueueToken(SECRET, CLAIMS, undefined, NOW);
    expect((await authorizeQueueWriteBack(SECRET, token, request, NOW)).ok).toBe(true);
  });

  it.each([
    ['another tenant', { ...request, tenantId: 'other' }],
    ['another thread', { ...request, threadId: 'acme:thread-2' }],
    ['another tool call', { ...request, toolCallId: 'call_2' }],
  ])('refuses a valid token presented for %s', async (_label, mismatched) => {
    // The signature is genuine — this is a real consumer reusing a token it
    // legitimately holds against work it was never given.
    const token = await mintQueueToken(SECRET, CLAIMS, undefined, NOW);
    expect(await authorizeQueueWriteBack(SECRET, token, mismatched, NOW)).toEqual({
      ok: false,
      reason: 'claim_mismatch',
    });
  });

  it('refuses an expired token even for the right dispatch', async () => {
    const token = await mintQueueToken(SECRET, CLAIMS, 1_000, NOW);
    expect(await authorizeQueueWriteBack(SECRET, token, request, NOW + 5_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('distinguishes a forgery from a scope mismatch for the caller', async () => {
    // The endpoint answers 401 either way, but the reason drives the counter
    // an operator reads to tell a bug from an attack.
    const forged = await mintQueueToken('wrong-secret-value-here-1234', CLAIMS, undefined, NOW);
    const valid = await mintQueueToken(SECRET, CLAIMS, undefined, NOW);
    expect(await authorizeQueueWriteBack(SECRET, forged, request, NOW)).toMatchObject({
      reason: 'bad_signature',
    });
    expect(
      await authorizeQueueWriteBack(SECRET, valid, { ...request, toolCallId: 'x' }, NOW),
    ).toMatchObject({ reason: 'claim_mismatch' });
  });
});
