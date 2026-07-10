import { describe, expect, it } from 'vitest';
import { cronMatches } from '../../src/jobs/cron';

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
