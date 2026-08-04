import { describe, expect, it } from 'vitest';
import { cronMatches, nextRunAfter } from '../../src/jobs/cron';

function utc(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

describe('cron matcher', () => {
  it('matches wildcards', () => {
    expect(cronMatches('* * * * *', utc(2026, 5, 13, 10, 30))).toBe(true);
  });

  it('matches literal fields', () => {
    expect(cronMatches('30 10 * * *', utc(2026, 5, 13, 10, 30))).toBe(true);
    expect(cronMatches('30 10 * * *', utc(2026, 5, 13, 10, 31))).toBe(false);
  });

  it('matches step expressions', () => {
    // every 5 minutes
    expect(cronMatches('*/5 * * * *', utc(2026, 5, 13, 10, 0))).toBe(true);
    expect(cronMatches('*/5 * * * *', utc(2026, 5, 13, 10, 5))).toBe(true);
    expect(cronMatches('*/5 * * * *', utc(2026, 5, 13, 10, 7))).toBe(false);
  });

  it('matches ranges', () => {
    expect(cronMatches('0 9-17 * * *', utc(2026, 5, 13, 9, 0))).toBe(true);
    expect(cronMatches('0 9-17 * * *', utc(2026, 5, 13, 17, 0))).toBe(true);
    expect(cronMatches('0 9-17 * * *', utc(2026, 5, 13, 18, 0))).toBe(false);
  });

  it('matches lists', () => {
    expect(cronMatches('0,15,30,45 * * * *', utc(2026, 5, 13, 10, 30))).toBe(true);
    expect(cronMatches('0,15,30,45 * * * *', utc(2026, 5, 13, 10, 32))).toBe(false);
  });

  it('rejects malformed expressions', () => {
    expect(cronMatches('not a cron', utc(2026, 5, 13, 10, 30))).toBe(false);
    expect(cronMatches('', utc(2026, 5, 13, 10, 30))).toBe(false);
  });
});

describe('nextRunAfter — schedules longer than a day must not strand a job', () => {
  // `listDueJobs` only selects rows with a non-null `next_run_at`, so a null
  // here stops the job firing permanently and silently. A bounded
  // minute-by-minute walk used to return null for every period over 24h.
  const friday9am = new Date(Date.UTC(2026, 7, 7, 9, 0, 0));

  it.each([
    ['weekday mornings', '0 9 * * 1-5'],
    ['weekly', '0 9 * * 1'],
    ['monthly', '0 9 1 * *'],
    ['yearly', '0 9 1 1 *'],
    ['daily', '0 9 * * *'],
    ['every five minutes', '*/5 * * * *'],
  ])('resolves a next run for %s', (_label, expr) => {
    const next = nextRunAfter(expr, friday9am);
    expect(next).not.toBeNull();
    // The value must satisfy the matcher the sweep re-checks it against,
    // otherwise the job is rescheduled forever without ever running.
    expect(cronMatches(expr, new Date(next as number))).toBe(true);
    expect(next as number).toBeGreaterThan(friday9am.getTime());
  });

  it('jumps the weekend for a weekday schedule', () => {
    const next = nextRunAfter('0 9 * * 1-5', friday9am) as number;
    expect(new Date(next).toISOString()).toBe('2026-08-10T09:00:00.000Z');
  });

  it('returns null only for a genuinely impossible date', () => {
    expect(nextRunAfter('0 0 30 2 *', friday9am)).toBeNull();
  });

  it('returns null for an empty or malformed expression', () => {
    expect(nextRunAfter('', friday9am)).toBeNull();
    expect(nextRunAfter('nonsense', friday9am)).toBeNull();
  });
});
