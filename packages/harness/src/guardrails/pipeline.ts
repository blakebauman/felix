/**
 * Built-in guardrail filter providers. Currently:
 *   - `pii`     — regex redactor for email / phone / SSN / credit card.
 *   - `bedrock` — placeholder bridge to an external content filter
 *                  (intended to wrap AI Gateway content policies). Returns
 *                  the value unchanged today, so it is REJECTED at manifest
 *                  validation time (see `GuardrailsSchema.providers` in
 *                  `src/guardrails/models.ts`) to avoid fail-open silent
 *                  pass-through. The registry entry stays as the wiring point
 *                  for the eventual AI Gateway content-policy hook.
 */

import { recordCounter } from '../observability/metrics';

export interface Match {
  provider: string;
  /** Stable fingerprint — *never* the raw matched text. */
  fingerprint: string;
}

export interface FilterResult {
  filtered: string;
  matches: Match[];
}

const PATTERNS: Array<{ name: string; rx: RegExp; replacement: string }> = [
  {
    name: 'email',
    rx: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: '[REDACTED:email]',
  },
  { name: 'ssn', rx: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED:ssn]' },
  {
    name: 'phone',
    rx: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replacement: '[REDACTED:phone]',
  },
  {
    name: 'credit_card',
    rx: /\b(?:\d[ -]*?){13,16}\b/g,
    replacement: '[REDACTED:cc]',
  },
];

async function digest(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function piiRedactor(input: string): Promise<FilterResult> {
  let filtered = input;
  const matches: Match[] = [];
  for (const p of PATTERNS) {
    const hits = filtered.match(p.rx);
    if (hits && hits.length > 0) {
      for (const hit of hits) {
        matches.push({ provider: `pii:${p.name}`, fingerprint: await digest(hit) });
      }
      filtered = filtered.replace(p.rx, p.replacement);
    }
  }
  return { filtered, matches };
}

export async function bedrockFilter(input: string): Promise<FilterResult> {
  return { filtered: input, matches: [] };
}

export const FILTERS: Record<string, (input: string) => Promise<FilterResult>> = {
  pii: piiRedactor,
  bedrock: bedrockFilter,
};

/**
 * Run a value through a provider chain, redacting in sequence and collecting
 * all matches. Unknown provider names are skipped (validation rejects them at
 * manifest-parse time). Shared by the tool-side wrapper (`wrap.ts`) and the
 * final-response guard (`final-response.ts`).
 */
export async function runFilters(providers: string[], value: string): Promise<FilterResult> {
  let current = value;
  const matches: FilterResult['matches'] = [];
  for (const name of providers) {
    const fn = FILTERS[name];
    if (!fn) {
      // Should be unreachable — GuardrailsSchema rejects unknown providers at
      // validation time. Count it anyway so a provider that slips through
      // (e.g. a hand-built Manifest bypassing Zod) is alertable rather than
      // silently disabling filtering.
      recordCounter('orchestrator_guardrail_provider_unknown', { provider: name });
      continue;
    }
    const r = await fn(current);
    current = r.filtered;
    matches.push(...r.matches);
  }
  return { filtered: current, matches };
}
