import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../src/auth/context';
import { authMiddleware } from '../../src/auth/middleware';
import type { Env } from '../../src/env';
import * as metricsModule from '../../src/observability/metrics';
import { rateLimitMiddleware } from '../../src/security/rate-limit';

afterEach(() => {
  vi.restoreAllMocks();
});

interface FakeRateLimit {
  binding: RateLimit;
  calls: Array<{ key: string }>;
}

/**
 * Fake RateLimit binding that:
 *   - records every call,
 *   - returns `success: true` for the first `allow` calls per key,
 *   - returns `success: false` afterwards.
 */
function fakeRateLimit(allow: number): FakeRateLimit {
  const counts = new Map<string, number>();
  const calls: FakeRateLimit['calls'] = [];
  const binding: RateLimit = {
    async limit({ key }) {
      calls.push({ key });
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= allow };
    },
  };
  return { binding, calls };
}

function fakeEnv(extra: Partial<Env> = {}): Env {
  return { ENVIRONMENT: 'development', ...(extra as object) } as Env;
}

function makeApp(env: Env) {
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
  app.use('*', authMiddleware());
  app.use('*', rateLimitMiddleware());
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/work', (c) => c.json({ tenant: c.get('auth').principal.tenantId }));
  return { app, env };
}

describe('rateLimitMiddleware', () => {
  it('passes when no binding is bound (soft-fail)', async () => {
    const { app, env } = makeApp(fakeEnv());
    const resp = await app.fetch(new Request('https://x/work'), env);
    expect(resp.status).toBe(200);
  });

  it('limits per-tenant once the quota is exhausted', async () => {
    const fake = fakeRateLimit(2);
    const { app, env } = makeApp(fakeEnv({ TENANT_RATE_LIMIT: fake.binding }));

    const r1 = await app.fetch(new Request('https://x/work'), env);
    const r2 = await app.fetch(new Request('https://x/work'), env);
    const r3 = await app.fetch(new Request('https://x/work'), env);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.headers.get('retry-after')).toBe('60');
    // All three should have used the default-tenant key.
    expect(fake.calls.map((c) => c.key)).toEqual(['default', 'default', 'default']);
  });

  it('skips /health entirely', async () => {
    const fake = fakeRateLimit(0); // would reject everything if called
    const { app, env } = makeApp(fakeEnv({ TENANT_RATE_LIMIT: fake.binding }));
    const resp = await app.fetch(new Request('https://x/health'), env);
    expect(resp.status).toBe(200);
    expect(fake.calls).toHaveLength(0);
  });

  it('fails open AND emits a counter if the binding throws', async () => {
    const counters: string[] = [];
    vi.spyOn(metricsModule, 'recordCounter').mockImplementation((name) => {
      counters.push(name);
    });
    const broken: RateLimit = {
      limit() {
        throw new Error('platform fault');
      },
    };
    const { app, env } = makeApp(fakeEnv({ TENANT_RATE_LIMIT: broken }));
    const resp = await app.fetch(new Request('https://x/work'), env);
    expect(resp.status).toBe(200);
    expect(counters).toContain('orchestrator_rate_limit_binding_error');
  });
});
