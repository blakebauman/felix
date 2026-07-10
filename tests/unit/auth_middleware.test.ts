import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../../src/auth/context';
import {
  authMiddleware,
  enforceManifestAuth,
  isAnonymous,
  requireAuthenticated,
  requireScope,
} from '../../src/auth/middleware';
import { requireContext } from '../../src/context';
import type { Env } from '../../src/env';
import { ManifestSchema } from '../../src/manifests/schema';

function fakeEnv(extra: Partial<Env> = {}): Env {
  return { ENVIRONMENT: 'production', ...(extra as object) } as Env;
}

function makeApp(env: Env) {
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
  app.use('*', authMiddleware());
  app.get('/whoami', (c) => {
    const auth = c.get('auth');
    return c.json({ anon: isAnonymous(auth), tenant: auth.principal.tenantId });
  });
  app.get('/admin', (c) => {
    const denied = requireAuthenticated(c);
    if (denied) return denied;
    return c.json({ ok: true });
  });
  return { app, env };
}

describe('authMiddleware', () => {
  it('accepts an unauthenticated request as anonymous', async () => {
    const { app, env } = makeApp(fakeEnv());
    const resp = await app.fetch(new Request('https://x/whoami'), env);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { anon: boolean; tenant: string };
    expect(body.anon).toBe(true);
    expect(body.tenant).toBe('default');
  });

  it('returns 401 when a token is supplied but no verifiers are configured (prod)', async () => {
    const { app, env } = makeApp(fakeEnv());
    const resp = await app.fetch(
      new Request('https://x/whoami', { headers: { authorization: 'Bearer abc.def.ghi' } }),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it('falls through to anonymous when a token is supplied in development', async () => {
    const { app, env } = makeApp(fakeEnv({ ENVIRONMENT: 'development' }));
    const resp = await app.fetch(
      new Request('https://x/whoami', { headers: { authorization: 'Bearer abc.def.ghi' } }),
      env,
    );
    expect(resp.status).toBe(200);
  });

  it('requireAuthenticated returns 401 on anonymous', async () => {
    const { app, env } = makeApp(fakeEnv());
    const resp = await app.fetch(new Request('https://x/admin'), env);
    expect(resp.status).toBe(401);
  });
});

describe('requireScope gating (control-plane routers)', () => {
  function scopedApp(env: Env) {
    const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
    app.use('*', authMiddleware());
    // Mirrors the pattern applied to /approvals/decide, /jobs, /eval, etc.
    app.post('/decide', (c) => {
      const denied = requireScope(c, 'approvals:decide');
      if (denied) return denied;
      return c.json({ ok: true });
    });
    return { app, env };
  }

  it('rejects anonymous with 401 in production (verifiers configured)', async () => {
    // A configured verifier makes anonymous callers fail closed rather than
    // fall through the dev escape hatch.
    const { app, env } = scopedApp(
      fakeEnv({ JWT_VERIFIERS: 'cognito https://issuer.example.com' }),
    );
    const resp = await app.fetch(new Request('https://x/decide', { method: 'POST' }), env);
    expect(resp.status).toBe(401);
  });

  it('falls through in development with no verifiers (local/test ergonomics)', async () => {
    const { app, env } = scopedApp(fakeEnv({ ENVIRONMENT: 'development' }));
    const resp = await app.fetch(new Request('https://x/decide', { method: 'POST' }), env);
    expect(resp.status).toBe(200);
  });
});

describe('self-authenticating mounts bypass JWT verification', () => {
  it('does not 401 an /acp bearer even when verifiers are configured', async () => {
    // Regression for Finding 5: /acp reuses `Authorization: Bearer <key>` for
    // its own API key. With JWT_VERIFIERS set, the global middleware must NOT
    // parse that bearer as a JWT and 401 before the ACP router's own check.
    const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
    app.use('*', authMiddleware({ selfAuthenticatingMounts: ['/acp'] }));
    app.post('/acp/checkout_sessions', (c) => {
      const auth = c.get('auth');
      return c.json({ anon: isAnonymous(auth) });
    });
    const env = fakeEnv({ JWT_VERIFIERS: 'cognito https://issuer.example.com' });
    const resp = await app.fetch(
      new Request('https://x/acp/checkout_sessions', {
        method: 'POST',
        headers: { authorization: 'Bearer acp_secret_key' },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { anon: boolean };
    expect(body.anon).toBe(true); // middleware left it anonymous; ACP enforces its own key
  });
});

describe('authMiddleware request-scoped disposal', () => {
  it('disposes the limit-state signal synchronously for non-streaming responses', async () => {
    const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
    app.use('*', authMiddleware());
    let signal: AbortSignal | undefined;
    app.get('/json', (c) => {
      signal = requireContext().limitState.abortController.signal;
      return c.json({ ok: true });
    });
    const resp = await app.fetch(
      new Request('https://x/json'),
      fakeEnv({ ENVIRONMENT: 'development' }),
    );
    expect(resp.status).toBe(200);
    // A plain response is fully produced before next() returns, so disposal
    // (and thus the abort) happens in the middleware's finally.
    expect(signal?.aborted).toBe(true);
  });

  it('does not abort the limit-state signal until an SSE body finishes streaming', async () => {
    // Regression: disposal used to run in a `finally` right after next(),
    // aborting the request-scoped controller before the SSE body's `start`
    // ran — every streamed model call died with `on_error: "request ended"`.
    const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
    app.use('*', authMiddleware());

    let signal: AbortSignal | undefined;
    let abortedWhenBodyStarted: boolean | undefined;

    app.get('/stream', () => {
      // Capture inside the handler, where the AsyncLocalStorage context is live.
      signal = requireContext().limitState.abortController.signal;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // Runs after the handler returns the Response. With the bug, the
          // signal is already aborted here.
          abortedWhenBodyStarted = signal?.aborted;
          controller.enqueue(encoder.encode('data: hello\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });

    const resp = await app.fetch(
      new Request('https://x/stream'),
      fakeEnv({ ENVIRONMENT: 'development' }),
    );
    expect(resp.headers.get('content-type')).toContain('text/event-stream');

    const text = await resp.text(); // drains the (re-wrapped) stream to completion
    expect(text).toContain('data: hello');
    expect(text).toContain('[DONE]');

    // The body must run with a live (un-aborted) signal.
    expect(abortedWhenBodyStarted).toBe(false);

    // Disposal is deferred to the pipe's completion (a microtask); let it settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(signal?.aborted).toBe(true);
  });
});

describe('enforceManifestAuth', () => {
  it('rejects anonymous when manifest disallows', async () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'p' },
      spec: { auth: { inbound: { allow_anonymous: false } } },
    });
    const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
    app.use('*', authMiddleware());
    app.get('/run', (c) => {
      const denied = enforceManifestAuth(c, manifest);
      if (denied) return denied;
      return c.json({ ok: true });
    });
    const resp = await app.fetch(new Request('https://x/run'), fakeEnv());
    expect(resp.status).toBe(401);
  });

  it('allows anonymous when manifest opts in', async () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'p' },
      spec: { auth: { inbound: { allow_anonymous: true } } },
    });
    const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
    app.use('*', authMiddleware());
    app.get('/run', (c) => {
      const denied = enforceManifestAuth(c, manifest);
      if (denied) return denied;
      return c.json({ ok: true });
    });
    const resp = await app.fetch(new Request('https://x/run'), fakeEnv());
    expect(resp.status).toBe(200);
  });
});
