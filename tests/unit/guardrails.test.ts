import { describe, expect, it } from 'vitest';
import { GuardrailsSchema } from '../../src/guardrails/models';
import { piiRedactor } from '../../src/guardrails/pipeline';

describe('pii redactor', () => {
  it('redacts email addresses', async () => {
    const r = await piiRedactor('contact me at test@example.com please');
    expect(r.filtered).not.toContain('test@example.com');
    expect(r.filtered).toContain('[REDACTED:email]');
    expect(r.matches[0]!.provider).toBe('pii:email');
  });

  it('passes through clean text', async () => {
    const r = await piiRedactor('hello world');
    expect(r.filtered).toBe('hello world');
    expect(r.matches).toHaveLength(0);
  });
});

describe('guardrails provider validation', () => {
  it('accepts the implemented `pii` provider', () => {
    const r = GuardrailsSchema.safeParse({ providers: ['pii'] });
    expect(r.success).toBe(true);
  });

  it('rejects the no-op `bedrock` provider (fail-loud, not fail-open)', () => {
    const r = GuardrailsSchema.safeParse({ providers: ['bedrock'] });
    expect(r.success).toBe(false);
  });

  it('rejects `bedrock` even when combined with a real provider', () => {
    const r = GuardrailsSchema.safeParse({ providers: ['pii', 'bedrock'] });
    expect(r.success).toBe(false);
  });
});
