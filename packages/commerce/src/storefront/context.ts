/**
 * Brand request context — the core of per-brand serving.
 *
 * Commerce tools (catalog/cart/checkout) read the tenant from the
 * `RequestContext`, not from the agent. A storefront request arrives anonymous
 * (no JWT for the brand), so to serve a brand we run the agent inside a fresh
 * context whose principal is an anonymous shopper scoped to the brand's data
 * tenant. AsyncLocalStorage nesting means this overrides the ambient
 * (default/anonymous) context the auth middleware installed.
 */

import type { AuthContext } from '@felix/orchestrator/auth/context';
import {
  getContext,
  newLimitState,
  type RequestContext,
  runWithContext,
} from '@felix/orchestrator/context';
import type { Env } from '@felix/orchestrator/env';

const BRAND_MANIFEST = 'orderloop';

/** Run `fn` with an anonymous-shopper context scoped to `brandTenant`. */
export function runWithBrandContext<T>(
  env: Env,
  execCtx: ExecutionContext | undefined,
  brandTenant: string,
  threadId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const ambient = getContext();
  const auth: AuthContext = {
    principal: { subject: '', tenantId: brandTenant, scopes: [], issuer: 'storefront' },
    outboundToken: ambient?.auth.outboundToken ?? (async () => ''),
  };
  const ctx: RequestContext = {
    env,
    execCtx: execCtx ?? ambient?.execCtx,
    auth,
    // Reuse the ambient limit state so per-run wall-clock/token caps still
    // apply to the storefront request as a whole.
    limitState: ambient?.limitState ?? newLimitState(),
    manifestId: BRAND_MANIFEST,
    ...(threadId ? { threadId } : {}),
  };
  return runWithContext(ctx, fn);
}
