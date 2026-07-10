/**
 * Constant-time secret comparison for shared-secret / API-key checks.
 *
 * Naive byte loops that first branch on `a.length !== b.length` leak the
 * expected secret's length via timing. We instead SHA-256 both inputs to a
 * fixed 32-byte digest and compare those in constant time — equal-length,
 * no early-exit, and the length of the supplied value is never observable.
 * Not a hot path (one call per authenticated infra request), so the extra
 * hash is negligible.
 */

async function sha256(input: string): Promise<Uint8Array> {
  const buf = new TextEncoder().encode(input);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i += 1) diff |= ha[i]! ^ hb[i]!;
  return diff === 0;
}
