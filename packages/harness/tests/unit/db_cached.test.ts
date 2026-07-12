/**
 * Cached-reads client seam (`getCachedDb` / `withCachedDb`).
 *
 * Pins:
 *   1. Without a HYPERDRIVE_CACHED binding, getCachedDb falls back to the
 *      default client (single-binding deployments behave identically).
 *   2. withCachedDb runs its callback under a child context whose DEFAULT
 *      client is the cached one — store code calling getDb inside
 *      transparently reads through the caching config.
 *   3. The parent context's default client is untouched after withCachedDb
 *      (writes outside the wrapper stay on the cache-disabled path).
 */

import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../../src/auth/context';
import {
  disposeContextDb,
  newLimitState,
  type RequestContext,
  runWithContext,
} from '../../src/context';
import { getCachedDb, getDb, withCachedDb } from '../../src/db/client';
import type { Env } from '../../src/env';
import { makeFakeSql } from '../helpers/fake-sql';

function ctxWith(env: Env): { ctx: RequestContext; texts: string[]; cachedTexts: string[] } {
  const texts: string[] = [];
  const cachedTexts: string[] = [];
  const { sql } = makeFakeSql((q) => {
    texts.push(q.text);
    return [];
  });
  const { sql: cachedSql } = makeFakeSql((q) => {
    cachedTexts.push(q.text);
    return [];
  });
  const ctx: RequestContext = {
    env,
    auth: ANONYMOUS,
    limitState: newLimitState(),
    db: sql,
    dbCached: cachedSql,
  };
  return { ctx, texts, cachedTexts };
}

describe('getCachedDb', () => {
  it('falls back to the default client when HYPERDRIVE_CACHED is absent', async () => {
    const env = { HYPERDRIVE: { connectionString: 'postgresql://fake' } } as unknown as Env;
    const { ctx } = ctxWith(env);
    ctx.dbCached = undefined; // absent binding + no cached client yet
    await runWithContext(ctx, async () => {
      expect(getCachedDb(env)).toBe(getDb(env));
    });
  });

  it('returns the context-cached client when present', async () => {
    const env = {
      HYPERDRIVE: { connectionString: 'postgresql://fake' },
      HYPERDRIVE_CACHED: { connectionString: 'postgresql://fake-cached' },
    } as unknown as Env;
    const { ctx } = ctxWith(env);
    await runWithContext(ctx, async () => {
      expect(getCachedDb(env)).toBe(ctx.dbCached);
    });
  });
});

describe('withCachedDb', () => {
  it('routes getDb calls inside the callback to the cached client, and restores outside', async () => {
    const env = {
      HYPERDRIVE: { connectionString: 'postgresql://fake' },
      HYPERDRIVE_CACHED: { connectionString: 'postgresql://fake-cached' },
    } as unknown as Env;
    const { ctx, texts, cachedTexts } = ctxWith(env);
    await runWithContext(ctx, async () => {
      await withCachedDb(env, async () => {
        await getDb(env)`SELECT 1 AS inside`;
      });
      await getDb(env)`SELECT 1 AS outside`;
    });
    expect(cachedTexts.join(' ')).toContain('inside');
    expect(cachedTexts.join(' ')).not.toContain('outside');
    expect(texts.join(' ')).toContain('outside');
    expect(texts.join(' ')).not.toContain('inside');
    disposeContextDb(ctx);
  });
});
