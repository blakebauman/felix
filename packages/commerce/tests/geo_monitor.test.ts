/**
 * GEO monitor — extraction parsing + env opts clamping (pure logic).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GEO_MONITOR_OPTS,
  parseExtraction,
  parseGeoMonitorOpts,
} from '../src/geo/monitor-job';

describe('parseExtraction', () => {
  it('parses a well-formed reply', () => {
    const out = parseExtraction(
      '{"mentioned": true, "rank": 2, "competitors": ["Nike", "Adidas"], "products": ["Trail X"]}',
    );
    expect(out).toEqual({
      mentioned: true,
      rank: 2,
      competitors: ['Nike', 'Adidas'],
      products: ['Trail X'],
    });
  });

  it('pulls JSON out of surrounding prose/code fences', () => {
    const out = parseExtraction('Here you go:\n```json\n{"mentioned": false, "rank": 0}\n```');
    expect(out.mentioned).toBe(false);
    expect(out.rank).toBe(0);
  });

  it('infers mention when a positive rank is present without the flag', () => {
    const out = parseExtraction('{"rank": 1}');
    expect(out.mentioned).toBe(true);
    expect(out.rank).toBe(1);
  });

  it('degrades to absent on malformed JSON', () => {
    expect(parseExtraction('not json at all')).toEqual({
      mentioned: false,
      rank: 0,
      competitors: [],
      products: [],
    });
  });

  it('ignores non-string array entries and negative ranks', () => {
    const out = parseExtraction(
      '{"mentioned": true, "rank": -3, "competitors": [1, "Nike", null]}',
    );
    expect(out.rank).toBe(0);
    expect(out.competitors).toEqual(['Nike']);
  });
});

describe('parseGeoMonitorOpts', () => {
  it('returns defaults when unset', () => {
    expect(parseGeoMonitorOpts({} as never)).toEqual(DEFAULT_GEO_MONITOR_OPTS);
  });

  it('clamps the per-tick cap and keeps valid model overrides', () => {
    const opts = parseGeoMonitorOpts({
      GEO_MONITOR: JSON.stringify({ max_queries_per_tick: 9999, gen_model: '@cf/custom' }),
    } as never);
    expect(opts.max_queries_per_tick).toBe(200); // ceiling
    expect(opts.gen_model).toBe('@cf/custom');
    expect(opts.extract_model).toBe(DEFAULT_GEO_MONITOR_OPTS.extract_model);
  });

  it('falls back to defaults on malformed JSON', () => {
    expect(parseGeoMonitorOpts({ GEO_MONITOR: '{bad' } as never)).toEqual(DEFAULT_GEO_MONITOR_OPTS);
  });
});
