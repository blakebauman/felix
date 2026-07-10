/**
 * Federation: a central authority ships a signed PolicyBundle that
 * augments every orchestrator's local manifest declarations. The active
 * bundle is held in `FederationDO`; a cron trigger refreshes it from R2.
 *
 * `mergeWithManifest` is invoked by the builder: it returns the effective
 * policies + approvals (manifest ∪ active bundle). Bundle wins on id
 * collision so a central policy override cannot be silently disabled by
 * a manifest.
 *
 * Signature contract: bundle JSON includes a top-level `signature` (base64
 * Ed25519 over the canonical JSON of the bundle with `signature` removed).
 * The public key lives in `env.POLICY_BUNDLE_PUBKEY` (base64 raw 32-byte).
 * Staging/production refuse to install an unsigned or tampered bundle;
 * development logs a warning and proceeds so local stacks can iterate
 * without setting up signing keys.
 */

import type { ApprovalRule } from '../approvals/models';
import type { Env } from '../env';
import { type Policy, type PolicyBundle, PolicyBundleSchema } from './models';

let activeBundle: PolicyBundle | null = null;

export function setActiveBundle(bundle: PolicyBundle | null): void {
  activeBundle = bundle;
}

export function getActiveBundle(): PolicyBundle | null {
  return activeBundle;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Deterministic JSON: sort object keys at every level. Sufficient for
 * Ed25519 over a bundle that has only primitive / object / array shapes.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(',')}}`;
}

async function verifyBundleSignature(
  raw: Record<string, unknown>,
  pubKeyB64: string,
): Promise<boolean> {
  if (typeof raw.signature !== 'string') return false;
  const sig = b64ToBytes(raw.signature);
  const pub = b64ToBytes(pubKeyB64);
  const { signature: _signature, ...unsigned } = raw;
  const message = new TextEncoder().encode(stableStringify(unsigned));
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      pub as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig as BufferSource, message);
  } catch (err) {
    console.warn('bundle signature verify failed', err);
    return false;
  }
}

export async function loadFromR2(env: Env, key?: string): Promise<PolicyBundle | null> {
  const k = key ?? env.POLICY_BUNDLE_KEY ?? 'bundles/active.json';
  const obj = await env.BUNDLES.get(k);
  if (!obj) return null;
  const raw = (await obj.json()) as Record<string, unknown>;

  const pubkey = env.POLICY_BUNDLE_PUBKEY;
  const dev = env.ENVIRONMENT === 'development';
  if (pubkey) {
    const ok = await verifyBundleSignature(raw, pubkey);
    if (!ok) {
      console.error('PolicyBundle signature verification failed; keeping previous active bundle');
      return activeBundle;
    }
  } else if (!dev) {
    console.error(
      'POLICY_BUNDLE_PUBKEY not configured in non-dev environment; refusing to install bundle',
    );
    return activeBundle;
  } else {
    console.warn('PolicyBundle loaded without signature verification (dev mode)');
  }

  const parsed = PolicyBundleSchema.parse(raw);
  setActiveBundle(parsed);
  return parsed;
}

export function mergeWithManifest(
  manifestPolicies: Policy[],
  manifestApprovals: ApprovalRule[],
): { policies: Policy[]; approvals: ApprovalRule[] } {
  if (!activeBundle) {
    return { policies: [...manifestPolicies], approvals: [...manifestApprovals] };
  }
  const policies = new Map<string, Policy>();
  for (const p of manifestPolicies) policies.set(p.id, p);
  for (const p of activeBundle.policies) policies.set(p.id, p); // bundle wins
  const approvals = new Map<string, ApprovalRule>();
  for (const a of manifestApprovals) approvals.set(a.id, a);
  // Bundle approvals are unknown shape (z.unknown()) in PolicyBundleSchema —
  // skip cross-merge until the federation schema for approvals is tightened.
  return { policies: [...policies.values()], approvals: [...approvals.values()] };
}
