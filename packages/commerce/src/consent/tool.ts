/**
 * `commerce_record_consent` — captures the buyer's explicit consent (terms,
 * data-share, marketing) for the current thread before checkout. When
 * `COMMERCE_REQUIRE_CONSENT=true`, `commerce_checkout` denies until a granted
 * consent exists for the thread; this tool is how the agent obtains it.
 *
 * Consent is append-only: each call writes a fresh row. The latest row for the
 * thread is authoritative, so a later `granted: false` records a withdrawal.
 */

import { recordEventDetached } from '@felix/orchestrator/audit/store';
import { getContext } from '@felix/orchestrator/context';
import { toolErrorOutput } from '@felix/orchestrator/tools/errors';
import { defineTool, type Tool, type ToolOutput } from '@felix/orchestrator/tools/types';
import { z } from 'zod';
import type { Consent } from './models';
import { recordConsent } from './store';

export function commerceRecordConsentTool(): Tool {
  return defineTool({
    name: 'commerce_record_consent',
    description:
      'Record the shopper’s consent for this conversation before checkout. Call after the ' +
      'shopper agrees to the terms and to sharing their details to complete the purchase. ' +
      'Pass granted=true when they agree; granted=false records a withdrawal.',
    args: z
      .object({
        granted: z.boolean().describe('True if the shopper consents; false to withdraw.'),
        scopes: z
          .array(z.string())
          .optional()
          .describe('What they consented to, e.g. ["terms","data_share","marketing"].'),
      })
      .strict(),
    source: 'commerce',
    async handler(args, ctx): Promise<ToolOutput> {
      const rc = getContext();
      if (!rc) return toolErrorOutput('internal', '[commerce error] no request context');
      const threadId = ctx?.threadId ?? '';
      if (!threadId) {
        return toolErrorOutput(
          'invalid_arguments',
          '[commerce error] consent requires a session thread; none was provided.',
        );
      }
      const env = rc.env;
      const tenantId = rc.auth.principal.tenantId;
      const consent: Consent = {
        tenant_id: tenantId,
        id: crypto.randomUUID(),
        subject: rc.auth.principal.subject ?? '',
        thread_id: threadId,
        channel: 'chat',
        scopes: args.scopes?.length ? args.scopes : ['terms'],
        granted: args.granted,
        terms_version: env.COMMERCE_TERMS_VERSION ?? '',
        policy_url: env.COMMERCE_PRIVACY_URL ?? '',
        created_at: Date.now(),
      };
      try {
        await recordConsent(env, consent);
      } catch (err) {
        return toolErrorOutput(
          'internal',
          `[commerce error] could not record consent: ${(err as Error).message}`,
        );
      }
      recordEventDetached(
        env,
        {
          tenantId,
          eventType: 'consent_recorded',
          manifestId: rc.manifestId ?? 'orderloop',
          principalSubject: consent.subject,
          status: consent.granted ? 'granted' : 'withdrawn',
          payload: { consent_id: consent.id, thread_id: threadId, scopes: consent.scopes },
        },
        rc.execCtx,
      );
      return consent.granted
        ? 'Thanks — your consent is recorded. You can complete checkout now.'
        : 'Your consent has been withdrawn; checkout will not proceed.';
    },
  });
}
