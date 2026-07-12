/**
 * Fake postgres.js client for unit tests.
 *
 * Mimics the slice of the postgres.js surface the harness stores use —
 * tagged-template queries (awaitable, `.count`), nested fragments
 * (`sql`AND x = ${y}``, `sql``` for the empty branch), the `sql(values)`
 * helper (IN-lists of scalars, multi-row inserts of objects), and
 * `sql.begin(fn)` — and routes every executed query to a test-provided
 * handler as `{ text, params }` so tests assert on query shape and drive
 * responses without a database.
 *
 * Query text uses `$n` placeholders. A multi-row `sql(rows)` helper renders
 * as `__ROWS__` with the raw array pushed as a single param. Scalar-list
 * helpers render as `($n, $n, ...)` with each value as a param.
 *
 * Inject via {@link withFakeDb}, which installs a RequestContext whose `db`
 * is the fake — `getDb(env)` returns the context-cached client, so stores
 * under test never open a real connection.
 */

import { buildAnonymousContext, disposeLimitState, runWithContext } from '../../src/context';
import type { Db } from '../../src/db/client';
import type { Env } from '../../src/env';

export interface CapturedQuery {
  text: string;
  params: unknown[];
}

/**
 * Return value drives the resolved rows: an array (rows; `count` =
 * `rows.length`), a number (no rows; `count` = n), `{ count }`, or
 * undefined (empty result). Throw to simulate a query error.
 */
export type FakeSqlHandler = (q: CapturedQuery) => unknown;

interface HelperMarker {
  __helper: true;
  value: unknown;
}

const EMPTY_STRINGS = Object.assign([''], { raw: [''] });

class FakeQuery {
  constructor(
    private readonly client: FakeSqlClient,
    readonly strings: TemplateStringsArray,
    readonly values: unknown[],
  ) {}

  /** Render this query (and nested fragments) into text + flat params. */
  render(out: CapturedQuery): void {
    for (let i = 0; i < this.strings.length; i += 1) {
      out.text += this.strings[i];
      if (i >= this.values.length) continue;
      const v = this.values[i];
      if (v instanceof FakeQuery) {
        v.render(out);
      } else if (isHelper(v)) {
        const val = v.value;
        if (Array.isArray(val) && val.every((x) => typeof x === 'object' && x !== null)) {
          out.text += '__ROWS__';
          out.params.push(val);
        } else if (Array.isArray(val)) {
          const slots = val.map((x) => {
            out.params.push(x);
            return `$${out.params.length}`;
          });
          out.text += `(${slots.join(', ')})`;
        } else {
          out.params.push(val);
          out.text += `$${out.params.length}`;
        }
      } else {
        out.params.push(v);
        out.text += `$${out.params.length}`;
      }
    }
  }

  private execute(): Promise<unknown[] & { count: number }> {
    const captured: CapturedQuery = { text: '', params: [] };
    this.render(captured);
    this.client.queries.push(captured);
    let result: unknown;
    try {
      result = this.client.handler(captured);
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve(result).then((r) => {
      if (Array.isArray(r)) return Object.assign([...r], { count: r.length });
      if (typeof r === 'number') return Object.assign([], { count: r });
      if (r && typeof r === 'object' && 'count' in r) {
        return Object.assign([], { count: (r as { count: number }).count });
      }
      return Object.assign([], { count: 0 });
    });
  }

  // Thenable — awaiting the tagged template executes it.
  // biome-ignore lint/suspicious/noThenProperty: intentional thenable mimicking postgres.js lazy queries
  then<T1, T2>(
    onFulfilled?: ((v: unknown[] & { count: number }) => T1) | null,
    onRejected?: ((reason: unknown) => T2) | null,
  ): Promise<T1 | T2> {
    return this.execute().then(onFulfilled, onRejected);
  }

  catch<T>(onRejected: (reason: unknown) => T): Promise<unknown> {
    return this.execute().catch(onRejected);
  }
}

function isHelper(v: unknown): v is HelperMarker {
  return typeof v === 'object' && v !== null && '__helper' in v;
}

interface FakeSqlClient {
  handler: FakeSqlHandler;
  queries: CapturedQuery[];
}

export interface FakeSql {
  sql: Db;
  /** Every executed query, in order. */
  queries: CapturedQuery[];
}

export function makeFakeSql(handler: FakeSqlHandler = () => []): FakeSql {
  const client: FakeSqlClient = { handler, queries: [] };
  const tag = (first: unknown, ...rest: unknown[]): unknown => {
    if (Array.isArray(first) && 'raw' in (first as unknown as TemplateStringsArray)) {
      return new FakeQuery(client, first as unknown as TemplateStringsArray, rest);
    }
    // Helper form: sql(values) / sql(rows)
    return { __helper: true, value: first } satisfies HelperMarker;
  };
  const sql = tag as unknown as Db & {
    begin: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown>;
    json: (v: unknown) => unknown;
  };
  Object.defineProperty(sql, 'begin', {
    value: (fn: (tx: Db) => Promise<unknown>) => fn(sql),
  });
  Object.defineProperty(sql, 'json', {
    value: (v: unknown) => ({ __helper: true, value: v }) satisfies HelperMarker,
  });
  return { sql, queries: client.queries };
}

/** An always-empty fragment, handy for handler-side comparisons. */
export const EMPTY_FRAGMENT_STRINGS = EMPTY_STRINGS;

/**
 * Run `fn` under a RequestContext whose `db` is the fake client, so every
 * `getDb(env)` call inside resolves to it. Mirrors how production code gets
 * a per-request client via the context cache.
 */
export async function withFakeDb<T>(env: Env, sql: Db, fn: () => Promise<T>): Promise<T> {
  const ctx = buildAnonymousContext(env);
  ctx.db = sql;
  try {
    return await runWithContext(ctx, fn);
  } finally {
    disposeLimitState(ctx.limitState);
  }
}
