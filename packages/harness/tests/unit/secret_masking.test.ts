/**
 * Masking this Worker's own secrets out of tool output.
 *
 * The shape-based scrubber can only catch credentials it recognizes; this
 * catches the ones it can't, by starting from the values we KNOW are secret.
 * The cases that matter are the encoded ones — a reflected URL returns a token
 * percent-encoded, a dumped request body returns it base64'd, and masking only
 * the literal string would leave both exposed while appearing to work.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Env } from '../../src/env';
import { applySecretMasking } from '../../src/security/masking-wrap';
import {
  collectSecrets,
  encodingsOf,
  maskSecrets,
  maskSecretsDeep,
} from '../../src/security/secret-masking';
import { ToolError } from '../../src/tools/errors';
import type { ToolExecutor } from '../../src/tools/executor';
import {
  defineToolWithExecutor,
  denyOutput,
  type Tool,
  type ToolOutput,
} from '../../src/tools/types';

const SECRET = 'sk-ant-supersecrettokenvalue0123456789';
const OPAQUE = 'zzq7Xk2LmPq9RtVw3Nh5Bd8Yc4Fj6Gs1';

function envWith(over: Record<string, unknown> = {}): Env {
  return {
    ANTHROPIC_API_KEY: SECRET,
    CONSUMER_SHARED_SECRET: OPAQUE,
    ENVIRONMENT: 'production',
    DEFAULT_MODEL_ID: 'claude-sonnet-4',
    ...over,
  } as unknown as Env;
}

function content(out: ToolOutput): string {
  return typeof out === 'string' ? out : out.content;
}

/** A tool returning whatever `output` says, on an untrusted transport. */
function toolReturning(output: string | ToolOutput, name = 'remote'): Tool {
  const executor: ToolExecutor = {
    transport: 'mcp',
    async execute() {
      return output;
    },
  };
  return defineToolWithExecutor({
    name,
    description: 'd',
    args: z.object({}).passthrough(),
    executor,
  });
}

describe('collectSecrets', () => {
  it('picks up values under secret-shaped key names', () => {
    const keys = collectSecrets(envWith() as unknown as Record<string, unknown>).map((s) => s.key);
    expect(keys).toContain('ANTHROPIC_API_KEY');
    expect(keys).toContain('CONSUMER_SHARED_SECRET');
  });

  it('leaves ordinary configuration alone', () => {
    const keys = collectSecrets(envWith() as unknown as Record<string, unknown>).map((s) => s.key);
    // Masking a model id would corrupt any output that legitimately names it.
    expect(keys).not.toContain('DEFAULT_MODEL_ID');
    expect(keys).not.toContain('ENVIRONMENT');
  });

  it('skips deliberately public values whose names read as secret', () => {
    const env = envWith({ JWKS_PUBLIC: 'a'.repeat(40), POLICY_BUNDLE_PUBKEY: 'b'.repeat(40) });
    const keys = collectSecrets(env as unknown as Record<string, unknown>).map((s) => s.key);
    expect(keys).not.toContain('JWKS_PUBLIC');
    expect(keys).not.toContain('POLICY_BUNDLE_PUBKEY');
  });

  it('catches a secret-shaped value under a benign key name', () => {
    const env = envWith({ SOME_SETTING: 'sk-ant-anothersecretvalue0123456789abc' });
    const keys = collectSecrets(env as unknown as Record<string, unknown>).map((s) => s.key);
    expect(keys).toContain('SOME_SETTING');
  });

  it('ignores short values and non-strings', () => {
    const env = envWith({ TOKEN: 'abc', AI: { run: () => {} } });
    const keys = collectSecrets(env as unknown as Record<string, unknown>).map((s) => s.key);
    expect(keys).not.toContain('TOKEN');
    expect(keys).not.toContain('AI');
  });
});

describe('encodingsOf', () => {
  it('includes the literal, percent-encoded, and base64 forms', () => {
    const forms = encodingsOf('a b+c/d=');
    expect(forms).toContain('a b+c/d=');
    expect(forms).toContain(encodeURIComponent('a b+c/d='));
    expect(forms.some((f) => f === btoa('a b+c/d=').replace(/=+$/, ''))).toBe(true);
  });

  it('does not duplicate a value whose encodings are identical', () => {
    const forms = encodingsOf('plaintoken123');
    expect(new Set(forms).size).toBe(forms.length);
  });
});

describe('maskSecrets', () => {
  const env = envWith();

  it('masks a secret echoed verbatim', () => {
    const out = maskSecrets(env, `error: request failed with key ${SECRET}`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[redacted:ANTHROPIC_API_KEY]');
  });

  it('masks a secret reflected inside a URL', () => {
    // The canonical leak: an upstream echoes the request it received.
    const out = maskSecrets(env, `called https://api.test/x?key=${encodeURIComponent(SECRET)}`);
    expect(out).not.toContain(encodeURIComponent(SECRET));
    expect(out).toContain('[redacted:ANTHROPIC_API_KEY]');
  });

  it('masks a base64-encoded secret', () => {
    const out = maskSecrets(env, `body: ${btoa(OPAQUE)}`);
    expect(out).not.toContain(btoa(OPAQUE));
    expect(out).toContain('[redacted:CONSUMER_SHARED_SECRET]');
  });

  it('masks an opaque secret no shape-based scrubber would recognize', () => {
    // This is the gap this module exists to close: OPAQUE matches no known
    // credential format, so pattern scrubbing never touches it.
    const out = maskSecrets(env, `shared secret is ${OPAQUE}`);
    expect(out).not.toContain(OPAQUE);
  });

  it('masks every occurrence, not just the first', () => {
    const out = maskSecrets(env, `${SECRET} and again ${SECRET}`);
    expect(out).not.toContain(SECRET);
  });

  it('leaves unrelated output untouched', () => {
    const text = 'order 4821 shipped to Lisbon via claude-sonnet-4';
    expect(maskSecrets(env, text)).toBe(text);
  });

  it('is a no-op when the environment holds no secrets', () => {
    const bare = { ENVIRONMENT: 'development' } as unknown as Env;
    expect(maskSecrets(bare, `nothing to mask ${SECRET}`)).toContain(SECRET);
  });
});

describe('applySecretMasking', () => {
  it('masks a secret a tool returned', async () => {
    const [wrapped] = applySecretMasking([toolReturning(`token=${SECRET}`)], envWith(), 'm');
    const out = await wrapped!.executor.execute({});
    expect(content(out)).not.toContain(SECRET);
    expect(content(out)).toContain('[redacted:ANTHROPIC_API_KEY]');
  });

  it('preserves the inner transport label', () => {
    const [wrapped] = applySecretMasking([toolReturning('ok')], envWith(), 'm');
    expect(wrapped!.executor.transport).toBe('mcp');
  });

  it('preserves output metadata while replacing content', async () => {
    const structured: ToolOutput = { content: `key ${SECRET}`, metadata: { source: 'upstream' } };
    const [wrapped] = applySecretMasking([toolReturning(structured)], envWith(), 'm');
    const out = await wrapped!.executor.execute({});
    expect(typeof out === 'string' ? undefined : out.metadata).toEqual({ source: 'upstream' });
    expect(content(out)).not.toContain(SECRET);
  });

  it('passes a wrapper deny through untouched', async () => {
    const deny = denyOutput('denied upstream', 'policy');
    const [wrapped] = applySecretMasking([toolReturning(deny)], envWith(), 'm');
    const out = await wrapped!.executor.execute({});
    expect(content(out)).toBe('denied upstream');
  });

  it('skips the wrap entirely when there are no secrets to mask', () => {
    const tool = toolReturning('ok');
    const bare = { ENVIRONMENT: 'development' } as unknown as Env;
    // Same object back — no indirection added on every tool call for nothing.
    expect(applySecretMasking([tool], bare, 'm')[0]).toBe(tool);
  });

  it('masks local tools too, since worker code can echo env as readily', async () => {
    const executor: ToolExecutor = {
      transport: 'local',
      async execute() {
        return `debug: ${SECRET}`;
      },
    };
    const tool = defineToolWithExecutor({
      name: 'debug',
      description: 'd',
      args: z.object({}).passthrough(),
      executor,
    });
    const [wrapped] = applySecretMasking([tool], envWith(), 'm');
    expect(content(await wrapped!.executor.execute({}))).not.toContain(SECRET);
  });

  it('does not call the inner tool more than once', async () => {
    const execute = vi.fn(async () => 'fine');
    const tool = defineToolWithExecutor({
      name: 't',
      description: 'd',
      args: z.object({}).passthrough(),
      executor: { transport: 'mcp', execute } as ToolExecutor,
    });
    const [wrapped] = applySecretMasking([tool], envWith(), 'm');
    await wrapped!.executor.execute({});
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('thrown errors are masked too', () => {
  /** A tool whose executor throws, the sanctioned hard-error convention. */
  function throwingTool(err: unknown): Tool {
    const executor: ToolExecutor = {
      transport: 'mcp',
      async execute() {
        throw err;
      },
    };
    return defineToolWithExecutor({
      name: 'boom',
      description: 'd',
      args: z.object({}).passthrough(),
      executor,
    });
  }

  it('masks a secret in a thrown ToolError, preserving its code', async () => {
    // This path is worse than a returned value: the react loop writes it to
    // the tool_call audit row, appends it to the transcript, and for a `fatal`
    // tool surfaces it directly as the user-visible answer.
    const tool = throwingTool(new ToolError('provider_error', `upstream rejected ${SECRET}`));
    const [wrapped] = applySecretMasking([tool], envWith(), 'm');

    await expect(wrapped!.executor.execute({})).rejects.toMatchObject({
      name: 'ToolError',
      code: 'provider_error',
    });
    const err = (await wrapped!.executor.execute({}).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain('[redacted:ANTHROPIC_API_KEY]');
  });

  it('masks a plain Error and keeps its name so error-code inference still works', async () => {
    const original = new Error(`fetch failed for ${SECRET}`);
    original.name = 'AbortError';
    const [wrapped] = applySecretMasking([throwingTool(original)], envWith(), 'm');

    const err = (await wrapped!.executor.execute({}).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain(SECRET);
    // `inferErrorCode` reads `name` to classify aborts — losing it would
    // reclassify a cancellation as an internal error.
    expect(err.name).toBe('AbortError');
  });

  it('rethrows the original error untouched when it holds no secret', async () => {
    const original = new ToolError('timeout', 'upstream timed out');
    const [wrapped] = applySecretMasking([throwingTool(original)], envWith(), 'm');
    const err = await wrapped!.executor.execute({}).catch((e: unknown) => e);
    expect(err).toBe(original);
  });
});

describe('maskSecretsDeep', () => {
  it('masks strings nested anywhere in a payload', () => {
    const out = maskSecretsDeep(envWith(), {
      args: { url: `https://x/y?k=${SECRET}` },
      count: 3,
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect((out as { count: number }).count).toBe(3);
  });

  it('is a no-op without an env', () => {
    expect(maskSecretsDeep(undefined, { a: SECRET })).toEqual({ a: SECRET });
  });
});

describe('robustness', () => {
  it('does not throw when a binding accessor throws', () => {
    // Audit recording runs the masker, so enumerating a hostile or lazy
    // binding must not take that path down.
    const env = {
      ANTHROPIC_API_KEY: SECRET,
      get HYPERDRIVE(): never {
        throw new Error('binding unavailable');
      },
    } as unknown as Env;
    expect(() => maskSecrets(env, `key ${SECRET}`)).not.toThrow();
    expect(maskSecrets(env, `key ${SECRET}`)).not.toContain(SECRET);
  });

  it('excludes a Stripe publishable key, which is meant to be public', () => {
    const env = envWith({ STRIPE_PUBLISHABLE_KEY: `pk_live_${'a'.repeat(24)}` });
    const keys = collectSecrets(env as unknown as Record<string, unknown>).map((s) => s.key);
    // Masking it would silently break a checkout that legitimately needs it.
    expect(keys).not.toContain('STRIPE_PUBLISHABLE_KEY');
  });

  it('masks correctly when one secret is a substring of another', () => {
    const short = 'sharedprefix1234';
    const long = `${short}_extended_tail_5678`;
    const env = { A_TOKEN: short, B_TOKEN: long } as unknown as Env;
    const out = maskSecrets(env, `values: ${long} and ${short}`);
    // Leftmost-longest ordering: the longer secret must not be left with an
    // unmasked tail because the shorter one matched its prefix first.
    expect(out).not.toContain(short);
    expect(out).not.toContain(long);
  });
});
