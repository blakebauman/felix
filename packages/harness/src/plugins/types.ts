/**
 * FelixPlugin — the seam that keeps feature packs (commerce, …) out of the
 * core. A plugin is a plain object bundling everything a feature contributes
 * to the harness: HTTP routers, tool factories, cron tasks, and the few
 * middleware knobs (self-authenticating mounts, rate-limit keying, body-size
 * floor) that core would otherwise have to hardcode per feature.
 *
 * Core never names a plugin. `composition.ts:installedPlugins()` is the single
 * wiring line; `app.ts`, `index.ts`, `auth/middleware.ts`, and
 * `security/rate-limit.ts` only ever iterate the list. Removing a feature is
 * deleting its entry from `installedPlugins()` — enforced by
 * `tests/unit/plugin_boundary.test.ts`.
 */

import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AuthContext } from '../auth/context';
import type { Env } from '../env';
import type { ToolProvider } from '../tools/provider';
import type { Tool } from '../tools/types';

/** The app shape plugins mount routes on — same generics as `createApp`. */
export type FelixApp = OpenAPIHono<{ Bindings: Env; Variables: { auth: AuthContext } }>;

/** Request context shape handed to `rateLimitKey` resolvers. */
export type FelixRequestContext = Context<{ Bindings: Env; Variables: { auth: AuthContext } }>;

export interface FelixPluginCronTask {
  /** Stable name used in error logs (`<name> failed`). */
  name: string;
  /**
   * Runs on every scheduled tick, inside the anonymous cron RequestContext
   * installed by `index.ts:scheduled`. Errors are caught per-task so one
   * failing plugin task never starves core crons or other plugins.
   */
  run(deps: {
    env: Env;
    tools: ToolProvider;
    now: number;
    execCtx: ExecutionContext;
  }): Promise<void>;
}

export interface FelixPlugin {
  name: string;
  /**
   * Mount HTTP routes. Called after the core sub-routers and before the
   * `/docs` site, so plugins may claim root paths (e.g. `/robots.txt`)
   * without shadowing core surfaces.
   */
  routes?(app: FelixApp, opts: { tools: ToolProvider }): void;
  /** Register tool factories on the shared ToolProvider. */
  registerTools?(register: (name: string, factory: () => Tool) => void): void;
  /**
   * Path prefixes that carry their own `Authorization: Bearer <key>` scheme
   * (NOT a JWT) and enforce it inside the router — the JWT middleware lets
   * them through as ANONYMOUS instead of 401ing the non-JWT bearer.
   */
  selfAuthenticatingMounts?: readonly string[];
  /**
   * Contribute a rate-limit bucket key for a request; return undefined to
   * fall through to the default per-tenant keying.
   */
  rateLimitKey?(c: FelixRequestContext): string | undefined;
  /**
   * Body-size floor (bytes) this plugin's routes need. The app-wide
   * `bodyLimit` cap is `max(core default, ...plugins)`.
   */
  bodyLimitBytes?: number;
  cronTasks?: readonly FelixPluginCronTask[];
}
