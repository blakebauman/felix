/**
 * Internal billing provider (default). No external PSP — invoices are tracked
 * in our own D1 and settled by an explicit mark-paid (operator/agent action).
 * This preserves the original behavior when no PSP is configured.
 */

import { registerBillingProvider } from './registry';
import type { BillingProvider } from './types';

class InternalProvider implements BillingProvider {
  readonly kind = 'internal';
  async issueInvoice() {
    return { status: 'open' as const };
  }
  async settle() {
    return { status: 'paid' as const };
  }
}

registerBillingProvider('internal', () => new InternalProvider());
