/**
 * B2B purchase authority. Decides whether a buyer may spend a given amount on
 * behalf of their account:
 *
 *   allowed           — within the buyer's authority; proceed.
 *   requires_approval — over the buyer's spending limit; route to an approver.
 *   blocked           — not permitted at all (suspended/disabled/viewer/over credit).
 *
 * Pure — the caller persists the approval request (see the router) using the
 * existing approvals pipeline when the decision is `requires_approval`.
 */

import type { Account, Buyer } from './models';

export type AuthorityDecision = 'allowed' | 'requires_approval' | 'blocked';

export interface AuthorityResult {
  decision: AuthorityDecision;
  reason: string;
}

export function purchaseAuthority(
  account: Account,
  buyer: Buyer,
  amountCents: number,
): AuthorityResult {
  if (account.status !== 'active') return { decision: 'blocked', reason: 'account is suspended' };
  if (buyer.status !== 'active') return { decision: 'blocked', reason: 'buyer is disabled' };
  if (buyer.account_id !== account.id)
    return { decision: 'blocked', reason: 'buyer does not belong to this account' };
  if (buyer.role === 'viewer')
    return { decision: 'blocked', reason: 'viewers cannot make purchases' };

  // Credit ceiling on net-terms accounts (a hard cap, not an approvable spend).
  if (
    account.payment_terms !== 'prepaid' &&
    account.credit_limit_cents > 0 &&
    amountCents > account.credit_limit_cents
  ) {
    return { decision: 'blocked', reason: 'amount exceeds the account credit limit' };
  }

  // Admins purchase without a per-buyer limit; everyone else is bounded.
  if (buyer.role === 'admin') return { decision: 'allowed', reason: 'account admin' };

  if (buyer.spending_limit_cents > 0 && amountCents > buyer.spending_limit_cents) {
    return { decision: 'requires_approval', reason: 'amount exceeds the buyer spending limit' };
  }
  return { decision: 'allowed', reason: 'within spending limit' };
}
