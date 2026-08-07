/**
 * Per-dispatch capability tokens for the queue write-back channel.
 *
 * The write-back endpoint authenticates a queue consumer with
 * `CONSUMER_SHARED_SECRET` — one fleet-global value that every consumer holds
 * and sends on every request. Dispatch pairing stops a holder from writing into
 * a thread that has no matching outstanding dispatch, so forged and
 * cross-tenant writes are already refused. But the credential itself grants
 * nothing narrower than "may attempt a write-back for any tenant", and it
 * travels to every consumer on every call, so anywhere it leaks — a log, a
 * proxy, a compromised consumer — it is the whole fleet's credential.
 *
 * A capability token narrows the credential to the work it authorizes. Minted
 * when a job is enqueued, carried in the queue message, and presented on the
 * way back, it says exactly one thing: *this* tool call, on *this* thread, for
 * *this* tenant, until *this* time. A leaked token authorizes one already-known
 * dispatch and nothing else, and the long-lived secret stops leaving the
 * Worker — it becomes a signing key rather than a bearer credential.
 *
 * Verification also stops trusting the request body for identity. The endpoint
 * used to parse the tenant out of the addressed thread id and validate by
 * pairing; with a token, tenant / thread / tool-call come from a signed claim
 * and the body has to agree with it.
 *
 * Deliberately not JWT: no algorithm field to confuse, no library, no `none`
 * to reject. One HMAC over one JSON claim set.
 */

import { constantTimeEqual } from './constant-time';

/** What a token authorizes. Kept short — it rides in every queue message. */
export interface QueueTokenClaims {
  /** Tenant that owns the thread. */
  t: string;
  /** Thread the result may be written to. */
  th: string;
  /** The single tool call this token answers. */
  c: string;
  /** Expiry, epoch ms. */
  e: number;
}

/** Default lifetime when the dispatch declares no deadline of its own. */
export const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Ceiling on a token's lifetime, regardless of the job deadline.
 *
 * A capability that never expires is a shared secret with extra steps. Seven
 * days is well past any queue job that is still meaningfully in flight, and
 * the orphan-cleanup cron settles dispatches long before this matters.
 */
export const MAX_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(sig));
}

/**
 * Mint a token for one dispatch. `ttlMs` is clamped to `MAX_TOKEN_TTL_MS`;
 * a non-positive value falls back to the default.
 */
export async function mintQueueToken(
  secret: string,
  claims: Omit<QueueTokenClaims, 'e'>,
  ttlMs: number = DEFAULT_TOKEN_TTL_MS,
  now: number = Date.now(),
): Promise<string> {
  const lifetime = ttlMs > 0 ? Math.min(ttlMs, MAX_TOKEN_TTL_MS) : DEFAULT_TOKEN_TTL_MS;
  const full: QueueTokenClaims = { ...claims, e: now + lifetime };
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(full)));
  return `${payload}.${await hmac(secret, payload)}`;
}

export type QueueTokenFailure =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  /** Signed and unexpired, but authorizes different work than was requested. */
  | 'claim_mismatch';

export type QueueTokenResult =
  | { ok: true; claims: QueueTokenClaims }
  | { ok: false; reason: QueueTokenFailure };

/**
 * Verify a token's signature and expiry. Does NOT check what it authorizes —
 * callers compare the returned claims against the request they received, so
 * the mismatch can be reported distinctly from a forgery.
 */
export async function verifyQueueToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): Promise<QueueTokenResult> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  // Signature first: never parse a payload that hasn't been authenticated.
  const expected = await hmac(secret, payload);
  if (!(await constantTimeEqual(signature, expected))) {
    return { ok: false, reason: 'bad_signature' };
  }

  const decoded = base64UrlDecode(payload);
  if (!decoded) return { ok: false, reason: 'malformed' };
  let claims: QueueTokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(decoded)) as QueueTokenClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof claims?.t !== 'string' ||
    typeof claims?.th !== 'string' ||
    typeof claims?.c !== 'string' ||
    !Number.isFinite(claims?.e)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  // `Number.isFinite` above matters here: `NaN <= now` is false, so a
  // non-finite expiry would otherwise read as a token that never expires.
  if (claims.e <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

/**
 * Full check: the token is valid AND authorizes exactly the work being asked
 * for. Every field is compared — a token for the right thread but a different
 * tool call authorizes nothing here.
 */
export async function authorizeQueueWriteBack(
  secret: string,
  token: string,
  request: { tenantId: string; threadId: string; toolCallId: string },
  now: number = Date.now(),
): Promise<QueueTokenResult> {
  const verified = await verifyQueueToken(secret, token, now);
  if (!verified.ok) return verified;
  const { claims } = verified;
  if (
    claims.t !== request.tenantId ||
    claims.th !== request.threadId ||
    claims.c !== request.toolCallId
  ) {
    return { ok: false, reason: 'claim_mismatch' };
  }
  return verified;
}
